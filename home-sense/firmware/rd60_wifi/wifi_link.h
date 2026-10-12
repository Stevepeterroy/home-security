#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <atomic>
#include <time.h>
#include "cJSON.h"
#include "mbedtls/base64.h"
#include "csi_link.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

static SemaphoreHandle_t linkMutex;
static QueueHandle_t incomingCommands;
static String outgoing;
static uint32_t oldestByteMs;
static std::atomic<bool> linkOverflow{false};
static std::atomic<bool> diagnosticsReady{false};
static std::atomic<bool> collectWifiLogs{false};
static bool wifiFault = false;
static String pairedModule, pairedToken;
static String enrollmentSecret;
static void requestEnrollment() {
  String endpoint = HAVEN_EXCHANGE_URL;
  endpoint.replace("/api/wifi/exchange", "/api/wifi/discover");
  String identity = WiFi.macAddress(); identity.replace(":", "");
  WiFiClientSecure tls; tls.setCACert(HAVEN_ROOT_CA);
  HTTPClient http; http.setConnectTimeout(1000); http.setTimeout(1000);
  if (!http.begin(tls, endpoint)) return;
  http.addHeader("Content-Type", "application/json");
  String body = "{\"deviceId\":\"" + identity + "\",\"requestSecret\":\"" + enrollmentSecret + "\"}";
  if (http.POST(body) == 200) {
    cJSON* reply = cJSON_Parse(http.getString().c_str());
    cJSON* module = cJSON_GetObjectItemCaseSensitive(reply, "moduleId");
    cJSON* token = cJSON_GetObjectItemCaseSensitive(reply, "deviceToken");
    if (cJSON_IsString(module) && cJSON_IsString(token) && strlen(module->valuestring) <= 100 && strlen(token->valuestring) <= 100) {
      pairedModule = module->valuestring; pairedToken = token->valuestring;
      Preferences saved; saved.begin("haven", false);
      saved.putString("module", pairedModule); saved.putString("token", pairedToken);
      saved.putString("server", HAVEN_EXCHANGE_URL); saved.end();
      ::Serial.println("[WIFI] Device added to Haven");
    }
    cJSON_Delete(reply);
  }
  http.end();
}

// Tee diagnostics without making the acquisition loop wait for HTTPS or USB.
class DiagnosticStream : public Print {
 public:
  using Print::write;
  void begin(unsigned long baud) { ::Serial.begin(baud); }
  int available() { return ::Serial.available(); }
  int read() { return ::Serial.read(); }
  void flush() {} // HTTP delivery happens on a separate task.
  size_t write(uint8_t value) override {
    if (::Serial && ::Serial.availableForWrite() > 0) ::Serial.write(value);
    if (!collectWifiLogs) return 1;
    if (linkMutex && xSemaphoreTake(linkMutex, pdMS_TO_TICKS(2))) {
      if (!outgoing.length()) oldestByteMs = millis();
      if (outgoing.length() < 32768) outgoing += (char)value;
      else linkOverflow = true;
      xSemaphoreGive(linkMutex);
    } else if (linkMutex) linkOverflow = true;
    return 1;
  }
};
static DiagnosticStream Diag;

static void wifiTask(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(HAVEN_WIFI_SSID, HAVEN_WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  char boot[33];
  snprintf(boot, sizeof(boot), "%08lx%08lx%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  enrollmentSecret = boot;
  uint64_t sequence = 0;
  String pending;
  uint32_t pendingSince = 0;
  uint32_t lastExchangeMs = 0;
  for (;;) {
    if (collectWifiLogs && millis() - lastExchangeMs > 3000) linkOverflow = true;
    if (!diagnosticsReady || WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) {
      vTaskDelay(pdMS_TO_TICKS(200)); continue;
    }
    if (pairedToken.isEmpty()) { requestEnrollment(); vTaskDelay(pdMS_TO_TICKS(2000)); continue; }
    startCsi();
    if (!collectWifiLogs) { lastExchangeMs = millis(); collectWifiLogs = true; }
    if (pending.isEmpty() && xSemaphoreTake(linkMutex, pdMS_TO_TICKS(20))) {
      pending = outgoing.substring(0, min((unsigned int)8192, outgoing.length()));
      pendingSince = outgoing.length() ? oldestByteMs : millis();
      outgoing.remove(0, pending.length());
      // Keep the oldest timestamp for any remainder; chunking cannot refresh it.
      xSemaphoreGive(linkMutex);
    }
    // Never upload stale logs as fresh observations. Reset Haven and restart ESP.
    if (pending.length() && millis() - pendingSince > 1000) {
      linkOverflow = true; vTaskDelay(pdMS_TO_TICKS(200)); continue;
    }
    unsigned char encoded[10925]; size_t encodedSize = 0;
    mbedtls_base64_encode(encoded, sizeof(encoded)-1, &encodedSize,
                          (const unsigned char*)pending.c_str(), pending.length());
    encoded[encodedSize] = 0;
    cJSON *packet = cJSON_CreateObject();
    cJSON_AddStringToObject(packet, "moduleId", pairedModule.c_str());
    cJSON_AddStringToObject(packet, "boot", boot);
    cJSON_AddNumberToObject(packet, "sequence", (double)sequence);
    cJSON_AddNumberToObject(packet, "age_ms", pending.length() ? millis()-pendingSince : 0);
    cJSON_AddStringToObject(packet, "data", (const char*)encoded);
    cJSON_AddItemToObject(packet,"csi",csiBatch());
    cJSON_AddNumberToObject(packet,"csi_dropped",csiDropped.load());
    char *payload = cJSON_PrintUnformatted(packet);
    WiFiClientSecure tls;
    tls.setCACert(HAVEN_ROOT_CA);
    HTTPClient http;
    http.setConnectTimeout(1000); http.setTimeout(1000);
    int code = -1; String response;
    if (payload && http.begin(tls, HAVEN_EXCHANGE_URL)) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("Authorization", String("Bearer ") + pairedToken);
      code = http.POST((uint8_t*)payload, strlen(payload));
      if (code == 200) response = http.getString();
    }
    http.end(); free(payload); cJSON_Delete(packet);
    if (code == 200) {
      cJSON *reply = cJSON_Parse(response.c_str());
      cJSON *ack = cJSON_GetObjectItemCaseSensitive(reply, "accepted");
      cJSON *commands = cJSON_GetObjectItemCaseSensitive(reply, "commands");
      if (cJSON_IsNumber(ack) && ack->valuedouble == (double)sequence && cJSON_IsArray(commands)) {
        cJSON *item;
        cJSON_ArrayForEach(item, commands) {
          if (cJSON_IsString(item) && strlen(item->valuestring) < 129) {
            char cmd[129] = {}; strlcpy(cmd, item->valuestring, sizeof(cmd));
            if (xQueueSend(incomingCommands, cmd, 0) != pdTRUE) linkOverflow = true;
          } else linkOverflow = true;
        }
        sequence++; pending = ""; lastExchangeMs = millis();
      }
      cJSON_Delete(reply);
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

static void beginWifiLink() {
  linkMutex = xSemaphoreCreateMutex();
  incomingCommands = xQueueCreate(32, 129);
  if (!linkMutex || !incomingCommands) { Diag.println("[ERROR] Wi-Fi queue allocation failed"); return; }
  pairedModule = HAVEN_MODULE_ID; pairedToken = HAVEN_DEVICE_TOKEN;
  if (pairedToken.isEmpty()) {
    Preferences saved; saved.begin("haven", true);
    if (saved.getString("server", "") == String(HAVEN_EXCHANGE_URL)) {
      pairedModule = saved.getString("module", ""); pairedToken = saved.getString("token", "");
    }
    saved.end();
  }
  if (!strlen(HAVEN_WIFI_SSID) || !strlen(HAVEN_ROOT_CA) || strncmp(HAVEN_EXCHANGE_URL, "https://", 8)) {
    Diag.println("[WIFI] Configure secrets.h before network use"); return;
  }
  if (xTaskCreatePinnedToCore(wifiTask, "haven_wifi", 24576, nullptr, 1, nullptr, 1) != pdPASS)
    Diag.println("[ERROR] Wi-Fi task allocation failed");
}
