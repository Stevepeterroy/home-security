# CSI acquisition and training status

Haven now collects router LLTF CSI on the ESP32-S3 alongside radar diagnostics. The callback copies 128 signed IQ bytes, RSSI, channel, first-word-invalid flag, device milliseconds and a sequence number into a bounded queue. Sampling is limited to 20 Hz; gateway ping stimulates reception. Only packets from the connected router BSSID are accepted. CSI batches use the authenticated, certificate-verified HTTPS radar transport. Samples older than one second are discarded; dropped samples are counted. The server retains at most 2000 samples per module and exports raw readings through `/api/csi/export` with an unlabelled marker.

The Sensors page includes a 30-second quiet calibration and channel-change motion detector. It normalizes packet amplitude, discards the first four bytes, rejects timing gaps, requires 12 valid two-second baseline windows and uses a robust baseline threshold. Calibration is invalidated by a boot or channel change; recalibrate after moving the router or sensor. This is a heuristic, not a trained activity model. CSI can vary with router packet format, gain, placement and environment. Router CSI does not locate a person at the ESP icon, and it does not produce heartbeat or breathing measurements automatically.

Haven compares calibrated CSI motion with fresh radar reflection speed evidence. Both positive sources produce `corroborated_motion`; conflicts are shown as disagreements. Stale data and incomplete radar previews without moving points produce unknown evidence. This rule does not enable care alerts, infer people, or claim better accuracy. Export includes raw CSI, available radar frames and placement, with explicit timing limitations. Radar host receipt timestamps are not synchronized radar acquisition timestamps.

## Primary sources

- Espressif router CSI example and ESP32-S3 support: https://github.com/espressif/esp-csi/tree/master/examples/get-started/csi_recv_router
- ESP-Fi HAR dataset: https://github.com/AutoSmartGroup/ESP-Fi-HAR

ESP-Fi HAR provides ESP32 amplitude samples with seven activities and scenario/participant identifiers under CC BY 4.0 (per its repository documentation). Its declared format is 950 time steps × 52 subcarriers. It is a candidate for source training; collection hardware/rate/subcarrier mapping must be assessed against our raw S3 router LLTF stream before transfer. Use participant-separated evaluation and preserve the original trial identity. Do not use the test set for model selection. The provided benchmark's training/test evaluation does not substitute for target validation.

## Remaining work

The offline `train_csi_source.py` baseline validates trial identity and amplitude shape, trains on participants 1–4, selects model depth using participants 5–6 and tests once on participants 7–8. Source models are never automatically enabled on the S3 stream. Download and verify the archive, run and inspect evaluation, then collect controlled labelled target CSI sessions and paired radar–CSI recordings. Validate each branch and their synchronization before enabling trained fusion prediction. Independently collected radar and CSI datasets are not paired examples and cannot establish fused accuracy. Acquisition alone must not turn on activity, fall or vital-sign capabilities.

## Completed source experiment

The archive SHA-256 is `85f3df633c5b1a48ca4b1423467fce22821b21eeb3eed085a8d9f983dc156660`, matching the upstream Git LFS pointer. All 2240 MAT trials loaded with valid identity, finite 950 × 52 amplitude and no duplicate trial IDs. The participant-disjoint random forest baseline achieved test balanced accuracy 0.3625 and macro F1 0.36847 on 560 held-out trials. Model selection used only the separate 560 validation trials; training used 1120 trials. Artifacts are in `data/training/csi-source/`; evaluation and the trial manifest are saved separately. This performance does not justify live activity or fall deployment.

The first source raw CSV has 983 packets over 9.979333 seconds (98.40 Hz), 104 IQ bytes, signal mode 1 and channel width code 1. Our router LLTF acquisition accepts 128 IQ bytes and is bounded at 20 Hz. Direct subcarrier/timing transfer is not established. These observed differences reinforce the need for target recordings instead of resampling and assuming compatibility.

Hardware recheck: 100 radar reports, acknowledged stop, CSI 2117 received samples, zero reported queue drops, both connections verified. No human activity label was attached to this uncontrolled run. Quiet calibration and a controlled movement trial remain operator steps.

## Collect paired target recordings

1. Keep sensor/router positions fixed. Calibrate a genuinely quiet area using the Sensors button, then test a controlled movement while radar is scanning.
2. Run one finite scan per observed activity. After the acknowledged stop, enter a session identifier, a consistent pseudonymous participant ID and the activity actually observed; choose Save to Haven.
3. Save before another scan or a Haven restart. The latest completed finite scan's overlapping CSI is held separately from the rolling buffer while Haven runs. A sensor can be unassigned to a room; that unknown placement is retained explicitly instead of blocking acquisition.
4. Review the recording and confirm the whole-session observation. Interrupted or mixed trials should be excluded. The saved quality summary shows CSI/radar overlap. Overlap alone does not prove fine acquisition synchronization.
5. Collect each activity from distinct participants in each intended train, validation and test group. Export the reviewed dataset. Repeat across pairs, placements and days before evaluating generalization.

`train_paired.py` evaluates radar-only, CSI-only and concatenated feature fusion on identical two-second windows and disjoint participant groups. It rejects CSI restarts/channel changes, missing sequences, device gaps over 200 ms, zero amplitude, fewer than 24 packets, short device-time coverage and poor approximate host-time coverage. It discards the first four IQ bytes in every packet. No interpolation or fabricated samples are inserted. An observed difference between branches is reported; improvement is never assumed or automatically deployed.

Example (replace the participant IDs with those actually recorded):

```
data/training/.venv/bin/python train_paired.py \
  --bundle /absolute/path/haven-reviewed-dataset.json \
  --output data/training/new-paired-experiment \
  --train participant-A participant-B \
  --validation participant-C \
  --test participant-D
```

Outputs include original reviewed data, window provenance, modality features, three model files, predictions and results. Existing experiment folders are not overwritten. Each split must contain every evaluated activity. The current real reviewed-session library is empty; synthetic quality tests are not training evidence for the home or a radar pair.

The physical motion comparison captured 100 radar reports and 343 CSI samples, with zero CSI sequence gaps. Both motion rules were positive at two sampled checks; radar was positive while CSI stayed quiet at other checks. This supports basic channel-change motion acquisition, not validated activity recognition or an accuracy improvement claim. The capture remains unlabelled until the operator supplies and reviews the activity. The quiet baseline was explicitly requested by the user and completed; subsequent connection recovery invalidated it, as intended.

## Training/live feature parity

`live_features.py` provides dependency-free radar (50), CSI (250) and combined (300) features using the same operations and two-second window gates as offline paired training. It does not enable a model or produce activity labels. Cross-implementation tests cover varied partial/empty radar clouds, CSI invalid-word exclusion, time/sequence gaps, boot/channel changes, zero amplitude and interval validation. Seven paired/parity tests pass.

On the real unlabelled motion capture, eight windows passed quality checks and matched the offline combined features within `1e-12`; two edge windows were rejected for incomplete time coverage. Evidence is saved in `evidence/live-feature-real-capture-check.json`. This proves processing compatibility for those readings, not detection accuracy, labels, model deployment or acquisition-clock synchronization. The reviewed target library remains empty pending actual operator labels and review.

## Numeric target-model runtime

Paired training now exports `radar-rf.json`, `csi-rf.json` and `fusion-rf.json` alongside offline joblib files. `rf_runtime.py` reads numeric tree arrays without executing pickle content. It validates the target domain, feature dimensions, class labels, tree topology, finite split thresholds and leaf votes; malformed or oversized packages are refused. Tree inputs are rounded to float32 to match scikit-learn prediction semantics. Votes are model outputs, not calibrated probabilities or independent ground truth.

Cross-implementation tests compare every branch's exported package against its offline model, including values close to split thresholds. Nine runtime, feature-parity and paired-pipeline tests pass. No JSON target model is installed in the Haven service, and these test fixtures are not evidence of a trained home detector. Real reviewed target recordings, held-out evaluation and explicit model activation remain outstanding; public-source CSI models are incompatible with this target package format and are not automatically deployed.

## Explicit experimental activation

The service now includes `ActivityRuntime` and reports `activityEstimate` in `/api/state`. It is off unless a numeric target package is explicitly configured using `HAVEN_ACTIVITY_MODEL`. The runtime requires participant-disjoint training/validation/test metadata, held-out evaluation of every model class and recorded module scope. It rejects invalid packages, refuses estimates for unrecorded modules and waits when the paired window is stale, discontinuous or incomplete. Model vote fractions are not calibrated probabilities. The Sensors page labels any output as an experimental sensor-window activity estimate, not an identified person or a medical reading.

After collecting, reviewing and evaluating actual target recordings, an operator can configure a selected package when launching the service:

```
HAVEN_ACTIVITY_MODEL="/absolute/path/to/evaluated-experiment/fusion-rf.json" tools/run_home_wifi.sh
```

Review the validation/test results and branch comparisons before choosing a model. Presence of evaluation metadata alone does not make a model accurate; this activation path permits explicit experimental use and does not enable care alerts, human counts, falls, heartbeat or breathing. The current production configuration has no activity model, and the reviewed library is empty. Synthetic tests exercise model loading, paired-window inference, class/split metadata, missing data and module scope without installing a fixture in the production service.
