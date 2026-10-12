import EmailSetup from "./EmailSetup";
import { resolveUrl } from "./serverConfig";
import { roomPath } from "./roomBoundary";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Home,
  Layers,
  Radio,
  Shield,
  Heart,
  Settings,
  Plus,
  ArrowUpRight,
  Play,
  Pause,
  ChevronLeft,
  Check,
  Bell,
  Download,
  Upload,
  MapPin,
  Activity,
  Wifi,
  LogOut,
} from "lucide-react";
import { enableBackgroundPush, disableBackgroundPush } from "./push";
import { RoomGesture } from "./roomGesture";
import { planViewBox, homePlanBounds, scanRooms } from "./planProjection";
import { useScanFootprint } from "./useScanFootprint";
import SessionLibrary from "./SessionLibrary";
import RadarDirection from "./RadarDirection";
import RoomDrawing from "./RoomDrawing";
import { placeModule, scanModules, syncScanEnvelope } from "./planPlacement";
import { roomSceneContext } from "./roomScene";
const Scene = lazy(() => import("./Scene"));
import {
  initialConfig,
  transform,
  clusters,
  Tracker,
  MultiTracker,
  inRoom,
} from "./domain";
import type { Config, Room, Frame, Track, Event } from "./domain";
import {
  saveSharedModel as saveModel,
  listSharedModels as listModels,
} from "./assets";
import type { ModelAsset } from "./assets";
type SyncRecord = {
  trialId: string;
  provider: "tasks" | "calendar";
  state: "pending" | "failed" | "synced";
  at: number;
  trialStatus: string;
  start: string;
  days: number;
  error?: string;
};
type Live = {
  connected: boolean;
  radar_verified: boolean;
  version: string;
  message: string;
  port: string;
  transport?: "usb" | "wifi";
  csi?: {connected:boolean;samples:number;dropped?:number;rssi?:number;channel?:number;approx_rate?:number;motion?:{status:string;remaining_seconds?:number}};
  motionEvidence?: {status:string};
  activityEstimate?: {enabled:boolean;status:string;label?:string;model_vote?:number;branch?:string};
  ports: { port: string; name: string }[];
  frames: Frame[];
  last_frame: Frame | null;
  now: number;
  scan_running: boolean;
  scan_pending: boolean;
  monitoring?: boolean;
  scan_cycles?: number;
  scan_error?: string;
  logs: string[];
  events?: Event[];
  nodes?: Record<string, Live>;
};
const uid = () => crypto.randomUUID();
const number = (value: FormDataEntryValue | null, fallback = 0) =>
  Number(value ?? fallback);
async function api(path: string, body?: unknown) {
  const r = await fetch(
    resolveUrl(path),
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "Request failed");
  return j;
}
function exportFile(data: string, name: string, type = "application/json") {
  const u = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
export default function App() {
  const roomGesture = useRef(new RoomGesture());
  useEffect(() => () => roomGesture.current.cancel(), []);

  const [cfg, setCfg] = useState<Config>(initialConfig),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState("home"),
    [mode, setMode] = useState<"recorded" | "live">("recorded"),
    [capture, setCapture] = useState<{ frames: Frame[] } | null>(null),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(true),
    [liveAggregate, setLive] = useState<Live | null>(null),
    [syncRecords, setSyncRecords] = useState<SyncRecord[]>([]),
    [pushStatus, setPushStatus] = useState<{
      configured: boolean;
      enrolled: boolean;
      devices: number;
      states: Record<string, number>;
    } | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [motionAlert, setMotionAlert] = useState<Event | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [hover, setHover] = useState<string | null>(null),
    [tracks, setTracks] = useState<Track[]>([]),
    [models, setModels] = useState<ModelAsset[]>([]),
    [scan, setScan] = useState<ModelAsset>(),
    [dialog, setDialog] = useState<"room" | "module" | null>(null),
    [placing, setPlacing] = useState<string | null>(null),
    [editingSensor, setEditingSensor] = useState<string | null>(null),
    [port, setPort] = useState("/dev/cu.usbserial-11320"),
    [capabilities, setCapabilities] = useState<{
      google_calendar_configured: boolean;
      google_tasks_configured: boolean;
      polycam_api_configured: boolean;
    } | null>(null),
    [polyCaptures, setPolyCaptures] = useState<{ id: string; name: string }[]>(
      [],
    );
  const [authStatus, setAuthStatus] = useState<{
      enrolled: boolean;
      authenticated: boolean;
      remote: boolean;
    } | null>(null),
    [authRequired, setAuthRequired] = useState(false),
    [authEnrolling, setAuthEnrolling] = useState(false);
  const [availableEsp, setAvailableEsp] = useState<{deviceId: string; name: string; approved: boolean}[]>([]);
  const [wifiKey, setWifiKey] = useState<{
    moduleId: string;
    token: string;
  } | null>(null);
  const [wifiPairing, setWifiPairing] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [sessionSaving, setSessionSaving] = useState(false);
  const scanState = useScanFootprint(scan);
  const footprint = scanState?.footprint;
  const bounds = useMemo(
    () => homePlanBounds(cfg.rooms, footprint),
    [cfg.rooms, footprint],
  );
  const mappedRooms = useMemo(
    () =>
      scan
        ? footprint
          ? scanRooms(cfg.rooms, scan.id, bounds)
          : []
        : cfg.rooms,
    [cfg.rooms, scan, footprint, bounds],
  );
  const scanArea = useMemo<Room | undefined>(
    () =>
      scan && footprint
        ? {
            id: "scan:" + scan.id,
            name: "Scanned space",
            x: 0,
            z: 0,
            width: footprint.width,
            depth: footprint.depth,
            care: false,
            modelId: scan.id,
          }
        : undefined,
    [scan, footprint],
  );
  const planRooms = useMemo(
    () => (mappedRooms.length ? mappedRooms : scanArea ? [scanArea] : []),
    [mappedRooms, scanArea],
  );
  const planModules = useMemo(
    () =>
      scan
        ? footprint
          ? scanModules(cfg.modules, cfg.rooms, scan, footprint)
          : []
        : cfg.modules,
    [cfg.modules, cfg.rooms, scan, footprint],
  );
  useEffect(() => {
    if (!scan || !footprint) return;
    setCfg((c) => {
      const rooms = syncScanEnvelope(c.rooms, scan, footprint);
      return rooms === c.rooms ? c : { ...c, rooms };
    });
  }, [scan, footprint]);
  useEffect(() => setWifiKey(null), [cfg.activeModuleId, authRequired]);
  const seenLiveEvents = useRef<Set<string> | null>(null);
  const multiTracker = useRef(new MultiTracker());
  const tracker = useRef(new Tracker()),
    lastFrame = useRef(""),
    awayCount = useRef(0),
    latched = useRef(false),
    configRef = useRef(cfg),
    notificationTimes = useRef<Record<string, number>>({});
  configRef.current = cfg;
  useEffect(() => {
    let active = true;
    api("/api/auth/status")
      .then((status) => {
        if (!active) return null;
        setAuthStatus(status);
        if (status.enrolled && !status.authenticated) {
          setAuthRequired(true);
          return null;
        }
        return Promise.all([
          api("/api/home"),
          api("/api/replay"),
          listModels(),
          api("/api/capabilities"),
        ]);
      })
      .then((result) => {
        if (!result) return;
        const [home, data, assets, caps] = result;
        if (!active) return;
        setCfg(home || initialConfig);
        setMode(home?.dataSource || "recorded");
        setCapture(data);
        setModels(assets);
        setScan(
          assets.find((a: ModelAsset) => a.id === home?.homeModelId) ||
            assets[0],
        );
        setCapabilities(caps);
        setPort(
          home?.modules?.find(
            (m: Config["modules"][number]) => m.id === home?.activeModuleId,
          )?.port ||
            home?.modules?.[0]?.port ||
            "/dev/cu.usbserial-11320",
        );
        setLoaded(true);
      })
      .catch((e) => setError("Could not load local service: " + e.message));
    const poll = () =>
      api("/api/state")
        .then((v) => {
          if (active) {
            setLive(v);
            if (v.availableDevices) setAvailableEsp(v.availableDevices);
            if (v.syncRecords) setSyncRecords(v.syncRecords);
            if (v.pushStatus) setPushStatus(v.pushStatus);
            if (v.events) {
              if (seenLiveEvents.current)
                for (const event of v.events) {
                  if (
                    event.source === "live" &&
                    !seenLiveEvents.current.has(event.id)
                  ) {
                    setMotionAlert(event);
                    if ("Notification" in window && Notification.permission === "granted")
                    new Notification("Haven: movement detected", {
                      body:
                        event.room +
                        ": radar reflections detected. Person identity is unverified.",
                    });
                  }
                }
              seenLiveEvents.current = new Set(
                v.events.map((e: Event) => e.id),
              );
            }
            if (v.events?.length)
              setCfg((c) => {
                const merged = new Map(c.events.map((e) => [e.id, e]));
                for (const event of v.events)
                  merged.set(event.id, {
                    ...event,
                    acknowledged:
                      event.acknowledged ||
                      merged.get(event.id)?.acknowledged ||
                      false,
                  });
                const events = [...merged.values()]
                  .sort((a, b) => b.at.localeCompare(a.at))
                  .slice(0, 200);
                return JSON.stringify(events) === JSON.stringify(c.events)
                  ? c
                  : { ...c, events };
              });
          }
        })
        .catch(() => {
          if (active) setLive(null);
        });
    poll();
    const t = setInterval(poll, 500);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(
      () =>
        api("/api/home", cfg).catch((e) =>
          setError("Changes could not be saved: " + e.message),
        ),
      350,
    );
    return () => clearTimeout(t);
  }, [cfg, loaded]);
  useEffect(() => {
    if (mode !== "recorded" || !playing || !capture) return;
    const t = setInterval(
      () => setIndex((i) => (i + 1) % capture.frames.length),
      200,
    );
    return () => clearInterval(t);
  }, [mode, playing, capture]);
  const module =
    cfg.modules.find((m) => m.id === cfg.activeModuleId) || cfg.modules[0];
  const live: Live | null = liveAggregate
    ? {
        ...liveAggregate,
        ...((module && liveAggregate.nodes?.[module.id]) || {
          connected: false,
          radar_verified: false,
          last_frame: null,
          frames: [],
          scan_running: false,
          scan_pending: false,
          logs: [],
          message: "This module is not connected",
        }),
      }
    : null;
  const freshNode = (id: string) => {
    const node = liveAggregate?.nodes?.[id];
    return (
      !!node?.connected &&
      node.radar_verified &&
      !!node.last_frame &&
      liveAggregate!.now - (node.last_frame.received_at || 0) < 1.5
    );
  };
  const anyFresh =
    mode === "recorded" ? !!capture : cfg.modules.some((m) => freshNode(m.id));
  const roomHasEvidence = (r: Room) =>
    mode === "recorded"
      ? !!frame &&
        !!module &&
        planModules.some((m) => m.id === module.id) &&
        (scan ? inRoom(module, r) : module.roomId === r.id)
      : planModules.some(
          (m) => (scan ? inRoom(m, r) : m.roomId === r.id) && freshNode(m.id),
        );
  const frame =
    mode === "recorded"
      ? capture?.frames[index]
      : live?.connected &&
          live.radar_verified &&
          live.last_frame &&
          live.now - (live.last_frame.received_at || 0) < 1.5
        ? live.last_frame
        : null;
  const points =
    mode === "recorded"
      ? frame && module && planModules.some((m) => m.id === module.id)
        ? frame.points.map((p) => transform(p, module))
        : []
      : planModules.flatMap((m) =>
          freshNode(m.id)
            ? liveAggregate!.nodes![m.id].last_frame!.points.map((p) =>
                transform(p, m),
              )
            : [],
        );
  useEffect(() => {
    if (mode === "live") {
      setTracks(
        multiTracker.current.update(
          planModules,
          liveAggregate?.nodes || {},
          liveAggregate?.now || Date.now() / 1000,
        ),
      );
      return;
    }
    const key = frame
      ? `${mode}:${frame.sequence}:${frame.received_at || 0}`
      : "";
    if (!frame || !module || !planModules.some((m) => m.id === module.id)) {
      tracker.current.reset();
      setTracks([]);
      lastFrame.current = "";
      awayCount.current = 0;
      return;
    }
    if (key === lastFrame.current) return;
    lastFrame.current = key;
    const time =
      mode === "recorded" ? frame.sequence * 0.2 : frame.received_at || 0;
    const next = tracker.current.update(
      clusters(frame.points.map((p) => transform(p, module))),
      time,
    );
    setTracks(next);
    const motion =
      frame.reported_points > 0 &&
      frame.points.some((p) => Math.abs(p.velocity_cm_s) >= 50);
    awayCount.current = motion ? awayCount.current + 1 : 0;
    if (!motion) latched.current = false;
    if (
      mode === "recorded" &&
      configRef.current.away &&
      awayCount.current >= 3 &&
      !latched.current
    ) {
      latched.current = true;
      const room =
        cfg.rooms.find((r) => r.id === module.roomId)?.name ||
        "Unassigned room";
      const event: Event = {
        id: uid(),
        at: new Date().toISOString(),
        room,
        kind: "Motion reflections while away — review needed",
        source: mode,
        acknowledged: false,
      };
      setCfg((c) => ({ ...c, events: [event, ...c.events].slice(0, 200) }));
    }
  }, [frame, module, mode, cfg.rooms, planModules, liveAggregate]);
  useEffect(() => {
    tracker.current.reset();
    lastFrame.current = "";
    latched.current = false;
    awayCount.current = 0;
    setTracks([]);
  }, [mode, module]);
  useEffect(() => {
    multiTracker.current.reset();
  }, [mode]);
  async function action(path: string, body: unknown = {}) {
    setError("");
    try {
      const result = await api(path, body);
      if (result.sync) {
        setSyncRecords((records) => [
          ...records.filter(
            (record) =>
              record.trialId !== result.sync.trialId ||
              record.provider !== result.sync.provider,
          ),
          result.sync,
        ]);
        setMessage(
          "Sync confirmed. Review the trial’s integration status for this attempt.",
        );
      } else
        setMessage("Request sent. Check the sensor status for confirmation.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const room = planRooms.find((r) => r.id === selected),
    hoverRoom = planRooms.find((r) => r.id === hover),
    roomTracks = (r: Room) => tracks.filter((t) => inRoom(t, r)),
    maxX = bounds.width,
    maxZ = bounds.depth;
  const spatialContext = useMemo(
    () =>
      room ? roomSceneContext(room, planModules, models, scan) : undefined,
    [room, planModules, models, scan],
  );
  function changeMode(next: "recorded" | "live") {
    setMode(next);
    setCfg((c) => ({ ...c, away: false, dataSource: next }));
    setMessage("Away mode disarmed when the data source changed.");
    setSelected(null);
  }
  async function importScan(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    try {
      if ([...files].reduce((n, f) => n + f.size, 0) > 150 * 1024 * 1024)
        throw Error("Choose a scan below 150 MB");
      if (![...files].some((f) => /\.(glb|gltf|obj)$/i.test(f.name)))
        throw Error("Choose a GLB, GLTF, or OBJ model");
      const model: ModelAsset = {
        id: uid(),
        name: [...files].find((f) => /\.(glb|gltf|obj)$/i.test(f.name))!.name,
        files: await Promise.all(
          [...files].map(async (f) => ({
            name: f.name,
            data: await f.arrayBuffer(),
          })),
        ),
        scale: 1,
        created: new Date().toISOString(),
      };
      await saveModel(model);
      setModels(await listModels());
      setScan(model);
      setCfg((c) => ({ ...c, homeModelId: model.id }));
      setMessage(
        "Scan saved to the workspace. Align the room boundaries and sensor position in Setup.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function updateScan(changes: Partial<ModelAsset>) {
    if (!scan) return;
    const next = { ...scan, ...changes };
    try {
      await saveModel(next);
      setModels(await listModels());
      setScan(next);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function submitRoom(form: HTMLFormElement) {
    const f = new FormData(form);
    const r: Room = {
      id: uid(),
      name: String(f.get("name")),
      x: number(f.get("x")),
      z: number(f.get("z")),
      width: number(f.get("width"), 4),
      depth: number(f.get("depth"), 4),
      care: false,
      planModelId: scan?.id,
    };
    setCfg((c) => ({ ...c, rooms: [...c.rooms, r] }));
    setDialog(null);
  }
  function submitModule(form: HTMLFormElement) {
    const f = new FormData(form);
    const m = {
      id: uid(),
      name: String(f.get("name")),
      roomId: scan ? "" : String(f.get("room")),
      x: number(f.get("x")),
      z: number(f.get("z")),
      height: number(f.get("height"), 1.2),
      yaw: number(f.get("yaw")),
      fov: 120,
      port: String(f.get("port")),
    };
    setCfg((c) => ({ ...c, modules: [...c.modules, m] }));
    if (scan) {
      setPlacing(m.id);
      setPage("setup");
      setMessage(
        "Module added. Tap its installed position on the scan to assign its room.",
      );
    }
    setDialog(null);
  }
  const nav = [
    ["home", "Overview", Home],
    ["sensors", "Sensors", Radio],
    ["care", "Care", Heart],
    ["events", "Activity log", Activity],
    ["setup", "Setup", Settings],
  ] as const;
  if (authRequired || authEnrolling)
    return (
      <div className="loading">
        <Home />
        <h1>{authEnrolling ? "Secure your workspace" : "Welcome back."}</h1>
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            const f = new FormData(e.currentTarget),
              password = String(f.get("password"));
            if (authEnrolling && password !== f.get("confirmation")) {
              setError("Passwords do not match");
              return;
            }
            try {
              await api(authEnrolling ? "/api/auth/setup" : "/api/auth/login", {
                password,
              });
              window.location.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Workspace password
            <input
              name="password"
              type="password"
              autoComplete={authEnrolling ? "new-password" : "current-password"}
              minLength={authEnrolling ? 12 : undefined}
              maxLength={128}
              required
            />
          </label>
          {authEnrolling && (
            <label>
              Confirm password
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                required
              />
            </label>
          )}
          <button className="primary">
            {authEnrolling ? "Create sign-in" : "Sign in"}
          </button>
          {authEnrolling && (
            <button type="button" onClick={() => setAuthEnrolling(false)}>
              Cancel
            </button>
          )}
          <p role="alert">{error}</p>
          <p className="muted small">
            {authEnrolling
              ? "Choose your own password. It is hashed locally; no preset password is created."
              : "Sign in to access your home scans, sensor settings and events."}
          </p>
        </form>
      </div>
    );
  if (!loaded)
    return (
      <div className="loading">
        <Home />
        <h1>Haven</h1>
        <p>{error || "Opening your home…"}</p>
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("home");
          }}
        >
          <div className="brand-icon">
            <Home size={22} />
          </div>
          haven<span>HOME SENSING</span>
        </a>
        <div className="home-switch">
          <span className="tiny">YOUR SPACE</span>
          <strong>{cfg.homeName}</strong>
          <span className="muted">Local workspace</span>
        </div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              onClick={() => {
                setPage(id);
                setSelected(null);
              }}
            >
              <Icon size={18} />
              {label}
              {id === "events" && cfg.events.some((e) => !e.acknowledged) && (
                <i />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span
            className={
              "status-dot " +
              (mode === "live" && live?.radar_verified ? "green" : "")
            }
          />
          {mode === "recorded" ? "Recorded data" : "Live sensor preview"}
          <p>
            Privacy starts at home.
            <br />
            Your scans stay in this workspace.
          </p>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="breadcrumb">
              {cfg.homeName} <span>/</span>{" "}
              {room ? room.name : nav.find((n) => n[0] === page)?.[1]}
            </div>
            <h1>
              {room
                ? room.name
                : page === "home"
                  ? "A little more peace of mind."
                  : nav.find((n) => n[0] === page)?.[1]}
            </h1>
            <p className="muted">
              {page === "home"
                ? "Your home, seen through signals."
                : page === "setup"
                  ? "Make the space yours. Place rooms, scans and sensors."
                  : "A clear view of what the system knows."}
            </p>
          </div>
          <div className="header-actions">
            {authStatus?.authenticated && (
              <button
                aria-label="Sign out"
                className="icon-btn"
                onClick={async () => {
                  await api("/api/auth/logout", {});
                  window.location.reload();
                }}
              >
                <LogOut size={17} />
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="Enable desktop alerts"
              onClick={async () => {
                if (!("Notification" in window)) {
                  setError(
                    "Desktop notifications are unavailable in this browser.",
                  );
                  return;
                }
                const p = await Notification.requestPermission();
                setMessage(
                  p === "granted"
                    ? "Desktop alerts enabled while Haven is open."
                    : "Desktop alerts are not enabled.",
                );
              }}
            >
              <Bell size={18} />
            </button>
            <span className="avatar">
              {(cfg.profile || "H")[0].toUpperCase()}
            </span>
          </div>
        </header>
        {!cfg.profile && (
          <section className="welcome">
            <div>
              <strong>Welcome home.</strong>
              <p>
                Name this local workspace to begin. No cloud account is
                required.
              </p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setCfg((c) => ({
                  ...c,
                  profile: String(f.get("profile")),
                  homeName: String(f.get("home")),
                }));
                setPage("setup");
              }}
            >
              <input
                name="profile"
                placeholder="Your name"
                aria-label="Your name"
                required
                maxLength={60}
              />
              <input
                name="home"
                placeholder="Home name"
                aria-label="Home name"
                defaultValue="My home"
                required
                maxLength={60}
              />
              <button className="primary">
                Get started <ArrowUpRight size={16} />
              </button>
            </form>
          </section>
        )}
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {message && (
          <div role="status" className="notice">
            {message}
            <button onClick={() => setMessage("")}>Dismiss</button>
          </div>
        )}
        {motionAlert && (
          <aside className="motion-popup" role="alert" aria-live="assertive">
            <strong>Movement detected while Away</strong>
            <p>{motionAlert.room}: moving radar reflections detected.</p>
            <div className="button-row">
              <button onClick={() => { setPage("events"); setSelected(null); setMotionAlert(null); }}>View activity</button>
              <button onClick={() => setMotionAlert(null)}>Dismiss</button>
            </div>
          </aside>
        )}
        <div className="source-strip">
          <div>
            <span
              className={
                "status-dot " +
                (mode === "live" && live?.radar_verified ? "green" : "")
              }
            />
            <strong>
              {mode === "recorded"
                ? "Recorded ESP capture · 6 Oct"
                : live?.radar_verified
                  ? "Radar verified · " + live.version
                  : live?.connected
                    ? "ESP connected · radar unverified"
                    : "ESP disconnected"}
            </strong>
            <span>
              {mode === "recorded"
                ? "Replay, not live sensing"
                : live?.message || "Local service unavailable"}
            </span>
          </div>
          <div className="segmented">
            <button
              className={mode === "recorded" ? "selected" : ""}
              onClick={() => changeMode("recorded")}
            >
              Replay
            </button>
            <button
              className={mode === "live" ? "selected" : ""}
              onClick={() => changeMode("live")}
            >
              Live
            </button>
          </div>
        </div>
        {page === "home" && !room && (
          <>
            <div className="button-row">
              <button disabled={!live?.radar_verified} onClick={async () => {
                changeMode("live");
                await action("/api/monitoring", {moduleId: module?.id, enabled: !live?.monitoring});
              }}>{live?.monitoring ? "Stop live monitoring" : "Start live monitoring"}</button>
              <span className="muted small">{live?.scan_running
                ? "Live radar readings update the counters below."
                : live?.monitoring || live?.scan_pending ? "Preparing the next radar scan; counters wait for fresh readings."
                : "Monitoring is stopped. Start it to show fresh coordinates and reflection groups."}</span>
            </div>
            <div className="metrics">
              <Metric
                label="People at home"
                value="—"
                detail="Person count is not validated"
              />
              <Metric
                label="Candidate reflection groups"
                value={anyFresh ? String(tracks.length) : "—"}
                detail="DBSCAN estimate · not people"
              />
              <Metric
                label="Visible radar coordinates"
                value={
                  frame
                    ? `${frame.points.length} / ${frame.reported_points}`
                    : "—"
                }
                detail={
                  frame?.preview_incomplete
                    ? "Partial console preview"
                    : "Current sensor report"
                }
              />
              <Metric
                label="Home mode"
                value={cfg.away ? "Away" : "At home"}
                detail={
                  cfg.away ? "Motion review rule armed" : "Monitoring overview"
                }
              />
            </div>
            <div className="overview-grid">
              <section className="panel floor-panel">
                <div className="panel-heading">
                  <div>
                    <span className="tiny">
                      {scan ? "YOUR SCANNED SPACE" : "GROUND FLOOR"}
                    </span>
                    <h2>Your home at a glance</h2>
                  </div>
                  <button className="text-btn" onClick={() => setPage("setup")}>
                    Edit layout <ArrowUpRight size={16} />
                  </button>
                </div>
                {scan && !footprint ? (
                  <div className="scan-plan-status" role="status">
                    {scanState?.error
                      ? `Could not process this scan: ${scanState.error}`
                      : "Processing your scan’s layout…"}
                  </div>
                ) : (
                  <div
                    className="floor-map"
                    style={{ aspectRatio: `${maxX}/${maxZ}` }}
                  >
                    {scan && (
                      <Suspense
                        fallback={<p role="status">Loading spatial view…</p>}
                      >
                        <Scene
                          rooms={planRooms}
                          modules={planModules}
                          tracks={[]}
                          model={scan}
                          plan
                          planBounds={bounds}
                        />
                      </Suspense>
                    )}
                    <svg
                      viewBox={planViewBox(
                        maxX,
                        maxZ,
                        bounds.minX,
                        bounds.minZ,
                      )}
                      role="img"
                      aria-label="Interactive top-down home floor plan"
                    >
                      {planRooms.map((r) => (
                        <g
                          key={r.id}
                          role="button"
                          tabIndex={0}
                          aria-label={"Open " + r.name}
                          onMouseEnter={() => setHover(r.id)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(r.id)}
                          onBlur={() => setHover(null)}
                          onPointerDown={(e) => {
                            if (e.pointerType !== "mouse")
                              roomGesture.current.begin(
                                e.clientX,
                                e.clientY,
                                () => setHover(r.id),
                              );
                          }}
                          onPointerMove={(e) => {
                            if (e.pointerType !== "mouse")
                              roomGesture.current.move(e.clientX, e.clientY);
                          }}
                          onPointerUp={() => roomGesture.current.end()}
                          onPointerCancel={() => roomGesture.current.cancel()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelected(r.id);
                            }
                          }}
                          onClick={() => {
                            if (roomGesture.current.consumeClick()) return;
                            if (placing) {
                              setMessage(
                                "Choose a position inside the room using the placement map in Setup.",
                              );
                              return;
                            }
                            setSelected(r.id);
                          }}
                        >
                          {r.boundary?.length ? (
                            <path d={roomPath(r)} className="room scan-room" />
                          ) : (
                            <>
                              <rect
                                className={
                                  scan
                                    ? "room scan-space"
                                    : scan
                                      ? "room scan-room"
                                      : "room"
                                }
                                x={r.x + 0.04}
                                y={r.z + 0.04}
                                width={r.width - 0.08}
                                height={r.depth - 0.08}
                                rx=".04"
                              />
                            </>
                          )}
                          <text
                            x={r.x + 0.3}
                            y={r.z + 0.5}
                            className="room-name"
                          >
                            {r.name}
                          </text>
                          <text
                            x={r.x + 0.3}
                            y={r.z + 0.86}
                            className="room-status"
                          >
                            {planModules.some((m) =>
                              r.id === scanArea?.id
                                ? inRoom(m, r)
                                : m.roomId === r.id,
                            )
                              ? roomHasEvidence(r)
                                ? `${roomTracks(r).length} candidate groups`
                                : "Waiting for sensor"
                              : "No sensor assigned"}
                          </text>
                          {r.care && (
                            <text
                              x={r.x + r.width - 0.5}
                              y={r.z + 0.5}
                              className="care-mark"
                            >
                              ♡
                            </text>
                          )}
                        </g>
                      ))}
                      {planModules.map((m) => (
                        <g key={m.id} aria-label={"Sensor " + m.name}>
                          <RadarDirection module={m} />
                          <circle
                            cx={m.x}
                            cy={m.z}
                            r=".13"
                            className="sensor-icon"
                          />
                          <path
                            d={`M${m.x - 0.16},${m.z + 0.2} Q${m.x},${m.z + 0.4} ${m.x + 0.16},${m.z + 0.2}`}
                            className="sensor-wave"
                          />
                        </g>
                      ))}
                      {points
                        .filter((p) => p.x >= bounds.minX && p.x <= bounds.minX + maxX && p.z >= bounds.minZ && p.z <= bounds.minZ + maxZ)
                        .map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x}
                            cy={p.z}
                            r=".07"
                            className="reflection-dot"
                          />
                        ))}
                      {tracks
                        .filter((t) => t.x >= bounds.minX && t.x <= bounds.minX + maxX && t.z >= bounds.minZ && t.z <= bounds.minZ + maxZ)
                        .map((t) => (
                          <g key={t.key || t.id}>
                            <polyline
                              className="trail"
                              points={t.trail
                                .map((p) => `${p.x},${p.z}`)
                                .join(" ")}
                            />
                            <circle
                              cx={t.x}
                              cy={t.z}
                              r=".1"
                              className="track-dot"
                            />
                            <circle
                              cx={t.x}
                              cy={t.z}
                              r=".19"
                              className="track-ring"
                            />
                          </g>
                        ))}
                    </svg>
                    {hoverRoom && (
                      <div className="room-tooltip">
                        <strong>{hoverRoom.name}</strong>
                        <span>People: unavailable</span>
                        <span>
                          {roomTracks(hoverRoom).length} candidate reflection
                          groups
                        </span>
                        <span>
                          Activity:{" "}
                          {roomTracks(hoverRoom).some(
                            (t) => Math.abs(t.velocity) >= 0.5,
                          )
                            ? "Moving reflections"
                            : "Unclassified"}
                        </span>
                        <small>Click to explore in 3D</small>
                      </div>
                    )}
                  </div>
                )}
                <div className="map-legend">
                  <span>
                    <i className="legend-sensor" />
                    Radar position
                  </span>
                  <span>
                    <i className="legend-dot" />
                    Candidate group
                  </span>
                  <span>
                    {scan
                      ? footprint
                        ? `${scan.name} · ${footprint.width.toFixed(2)} × ${footprint.depth.toFixed(2)} m`
                        : "Processing imported scan"
                      : "Example layout · customize in Setup"}
                  </span>
                </div>
                {scan && footprint && !mappedRooms.length && (
                  <p className="muted small">
                    This is your scan’s footprint. Name and mark rooms in Setup
                    to show individual room details.
                  </p>
                )}
                {mode === "recorded" && (
                  <div className="playback">
                    <button
                      aria-label={playing ? "Pause replay" : "Play replay"}
                      onClick={() => setPlaying((p) => !p)}
                    >
                      {playing ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <input
                      type="range"
                      aria-label="Recorded report"
                      min="0"
                      max={(capture?.frames.length || 1) - 1}
                      value={index}
                      onChange={(e) => {
                        setIndex(Number(e.target.value));
                        setPlaying(false);
                      }}
                    />
                    <small>
                      Report {index + 1} / {capture?.frames.length}
                    </small>
                  </div>
                )}
              </section>
              <div className="overview-side">
                <section className="mode-card">
                  <div className="mode-icon">
                    <Shield size={23} />
                  </div>
                  <h2>
                    {cfg.away ? "Keeping an eye out." : "Home feels like home."}
                  </h2>
                  <p>
                    {cfg.away
                      ? "Persistent moving reflections raise a review event."
                      : "Arm Away mode to flag movement while you are out."}
                  </p>
                  <button
                    className={cfg.away ? "secondary" : "primary"}
                    onClick={() => {
                      if (!cfg.away && mode === "live") {
                        if ("Notification" in window && Notification.permission === "default")
                          void Notification.requestPermission();
                        if (live?.radar_verified && !live.monitoring)
                          void action("/api/monitoring", { moduleId: module?.id, enabled: true });
                      }
                      if (cfg.away) setMotionAlert(null);
                      setCfg((c) => ({
                        ...c,
                        away: !c.away,
                        dataSource: mode,
                      }));
                      latched.current = false;
                      awayCount.current = 0;
                    }}
                  >
                    {cfg.away ? "Return to At home" : "Enable Away mode"}{" "}
                    <ArrowUpRight size={16} />
                  </button>
                  <small>
                    {mode === "recorded"
                      ? "Events are clearly marked as replay."
                      : "Local alerts; remote delivery is not connected."}
                  </small>
                </section>
                <section className="panel care-card">
                  <Heart size={22} />
                  <h3>A thoughtful check-in.</h3>
                  <p>
                    Room-level care monitoring starts with trustworthy sensing.
                  </p>
                  <span className="tag">Vitals unavailable</span>
                  <button className="text-btn" onClick={() => setPage("care")}>
                    View care status <ArrowUpRight size={16} />
                  </button>
                </section>
              </div>
            </div>
            <section className="room-list">
              {planRooms.map((r) => (
                <button
                  key={r.id}
                  className="room-card"
                  onClick={() => setSelected(r.id)}
                >
                  <div>
                    <Layers size={19} />
                    {r.care && <Heart size={16} />}
                  </div>
                  <h3>{r.name}</h3>
                  <p>
                    {
                      planModules.filter((m) =>
                        scan ? inRoom(m, r) : m.roomId === r.id,
                      ).length
                    }{" "}
                    sensor assigned
                  </p>
                  <span>
                    {roomHasEvidence(r)
                      ? `${roomTracks(r).length} candidate groups`
                      : "No fresh room evidence"}
                  </span>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </section>
          </>
        )}
        {page === "home" && room && (
          <>
            <button className="text-btn back" onClick={() => setSelected(null)}>
              <ChevronLeft size={16} />
              Back to overview
            </button>
            <div className="room-detail">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Spatial view</h2>
                  <span className="tag">
                    {spatialContext?.role === "room"
                      ? "Imported room scan"
                      : spatialContext?.role === "home"
                        ? "Imported home scan"
                        : "Schematic room geometry"}
                  </span>
                </div>
                <div className="spatial">
                  <Suspense
                    fallback={<p role="status">Loading spatial view…</p>}
                  >
                    <Scene
                      rooms={spatialContext!.rooms}
                      modules={spatialContext!.modules}
                      tracks={tracks}
                      points={points}
                      model={spatialContext!.model}
                      modelOrigin={spatialContext!.modelOrigin}
                      selected={room}
                      planBounds={bounds}
                    />
                  </Suspense>
                </div>
                {spatialContext?.missingRoomModel && (
                  <p className="muted small">
                    The assigned room scan is unavailable.{" "}
                    {spatialContext.model
                      ? "The home scan is shown."
                      : "Schematic room geometry is shown."}
                  </p>
                )}
                <p className="muted small">
                  Drag to orbit · pinch or scroll to zoom. Small dots are radar
                  reflections; larger dots are candidate groups.
                </p>
              </section>
              <section className="panel room-insights">
                <span className="tiny">ROOM DETAILS</span>
                <h2>{room.name}</h2>
                <Metric
                  label="People"
                  value="Unavailable"
                  detail="No validated human count"
                />
                <Metric
                  label="Candidate groups"
                  value={
                    roomHasEvidence(room)
                      ? String(roomTracks(room).length)
                      : "—"
                  }
                  detail="Partial coordinates can miss or merge groups"
                />
                <Metric
                  label="Activity"
                  value={
                    roomTracks(room).some((t) => Math.abs(t.velocity) >= 0.5)
                      ? "Moving reflections"
                      : "Unclassified"
                  }
                  detail="Velocity rule, not activity recognition"
                />
                <div className="vitals">
                  <span>
                    ♡ Heart rate <strong>Unavailable</strong>
                  </span>
                  <span>
                    Breathing <strong>Unavailable</strong>
                  </span>
                  <span>
                    Fall detection <strong>Not validated</strong>
                  </span>
                </div>
              </section>
            </div>
          </>
        )}
        {page === "sensors" && (
          <>
            <div className="section-title">
              <h2>Your sensing modules</h2>
              <button className="primary" onClick={() => setDialog("module")}>
                <Plus size={16} />
                Add module
              </button>
            </div>
            {cfg.modules.map((m, i) => (
              <section className="panel sensor-card" key={m.id}>
                <Radio />
                <div>
                  <h3>{m.name}</h3>
                  <p>
                    {cfg.rooms.find((r) => r.id === m.roomId)?.name} · x{" "}
                    {m.x.toFixed(1)} m, y {m.z.toFixed(1)} m · yaw {m.yaw}°
                  </p>
                  <small>
                    {m.id === module?.id
                      ? "Active input binding"
                      : "Independent module connection"}
                  </small>
                </div>
                <span className="tag">
                  {liveAggregate?.nodes?.[m.id]?.radar_verified
                    ? "Verified"
                    : "Not verified"}
                </span>
              </section>
            ))}
            <section className="panel">
              <h2>Connect the ESP</h2>
              <label>
                Active sensor input
                <select
                  aria-label="Active sensor input"
                  value={module?.id || ""}
                  onChange={(e) => {
                    const m = cfg.modules.find((m) => m.id === e.target.value);
                    setCfg((c) => ({
                      ...c,
                      activeModuleId: m?.id,
                      away: false,
                    }));
                    if (m) setPort(m.port);
                  }}
                >
                  {cfg.modules.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                For USB connections, close Arduino’s Serial Monitor first. For
                wireless sensing, use Wi-Fi pairing below after installing the
                configured Wi-Fi firmware on the ESP.
              </p>
              <label>
                Available serial port
                <select value={port} onChange={(e) => setPort(e.target.value)}>
                  <option value="/dev/cu.usbserial-11320">
                    /dev/cu.usbserial-11320
                  </option>
                  {live?.ports
                    .filter((p) => p.port !== "/dev/cu.usbserial-11320")
                    .map((p) => (
                      <option key={p.port}>{p.port}</option>
                    ))}
                </select>
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => {
                    setCfg((c) => ({
                      ...c,
                      modules: c.modules.map((m) =>
                        m.id === module?.id ? { ...m, port } : m,
                      ),
                    }));
                    api("/api/home", {
                      ...cfg,
                      activeModuleId: module?.id,
                      modules: cfg.modules.map((m) =>
                        m.id === module?.id ? { ...m, port } : m,
                      ),
                    })
                      .then(() =>
                        action("/api/connect", { port, moduleId: module?.id }),
                      )
                      .catch((e) => setError(e.message));
                  }}
                  disabled={live?.connected}
                >
                  Connect ESP
                </button>
                <button
                  onClick={() =>
                    action("/api/disconnect", { moduleId: module?.id })
                  }
                >
                  Disconnect
                </button>
                <button
                  onClick={() => action("/api/scan", { moduleId: module?.id })}
                  disabled={
                    !live?.radar_verified ||
                    live.scan_pending ||
                    live.scan_running
                  }
                >
                  Start 20-second scan
                </button>
                <button
                  disabled={!live?.radar_verified}
                  onClick={() =>
                    action("/api/monitoring", {
                      moduleId: module?.id,
                      enabled: !live?.monitoring,
                    })
                  }
                >
                  {live?.monitoring
                    ? "Stop monitoring"
                    : "Start persistent monitoring"}
                </button>
                <button
                  onClick={() => action("/api/stop", { moduleId: module?.id })}
                  disabled={!live?.scan_running}
                >
                  Stop
                </button>
                <button
                  onClick={async () => {
                    try {
                      exportFile(
                        JSON.stringify(
                          await api(
                            "/api/export?moduleId=" +
                              encodeURIComponent(module?.id || ""),
                          ),
                          null,
                          2,
                        ),
                        "haven-live-capture.json",
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Download size={16} />
                  Export live capture
                </button>
              </div>
              <p role="status">{live?.message || "Service unavailable"}</p>
              {live?.connected && (
                <p className="muted small">
                  Connection: {live.transport === "wifi" ? "Home Wi-Fi" : "USB"}
                </p>
              )}
              <p className="muted small">
                {live?.monitoring
                  ? "Monitoring is active in the local service. Finite scans repeat, with gaps during reconfiguration."
                  : ""}{" "}
                {live?.scan_cycles
                  ? `${live.scan_cycles} scan cycles started.`
                  : ""}
              </p>
              <details>
                <summary>Diagnostic log</summary>
                <pre>{live?.logs.join("\n")}</pre>
              </details>
            </section>
            <section className="panel">
              <h2>Connect over home Wi-Fi</h2>
              <h3>Available devices</h3>
              <button onClick={async () => {
                try { setAvailableEsp(await api("/api/wifi/devices")); }
                catch (error) { setError((error as Error).message); }
              }}>Find available ESPs</button>
              {availableEsp.length === 0 && <p className="muted small">Choose Find available ESPs after powering an ESP with Haven Wi-Fi firmware.</p>}
              {availableEsp.map(device => <div key={device.deviceId} className="button-row">
                <span>{device.name}</span>
                <button disabled={!module || !authStatus?.enrolled || live?.connected || device.approved}
                  onClick={async () => {
                    try {
                      await api("/api/home", cfg);
                      await api("/api/wifi/approve", {deviceId:device.deviceId,moduleId:module?.id});
                      setAvailableEsp(await api("/api/wifi/devices"));
                      setMessage("ESP added to the selected sensor. It will connect automatically.");
                    } catch(error) { setError((error as Error).message); }
                  }}>{device.approved ? "Added" : "Add to selected sensor"}</button>
              </div>)}

              <p>
                {live?.connected && live.transport === "wifi"
                  ? `Connected over Wi-Fi. ${live.radar_verified ? "Radar verified." : "Verifying radar…"} ${live.csi?.connected ? "CSI readings are arriving." : "Waiting for fresh CSI readings."}`
                  : "Power the ESP with its configured Wi-Fi firmware and keep Haven running on the same reachable network. An existing paired ESP connects automatically; use Reset Wi-Fi connection if you previously chose Disconnect."}
                {" "}To add another ESP, find an available device above and add it to the selected sensor.
              </p>
              <p className="muted small">
                New-device pairing requires workspace sign-in. Disconnect this
                sensor before creating or replacing its key. Keep Haven running
                and the radar and ESP powered after removing the computer’s USB
                cable.
              </p>
              {authStatus && !authStatus.enrolled && !live?.connected && (
                <button onClick={() => setAuthEnrolling(true)}>
                  Set up sign-in for Wi-Fi pairing
                </button>
              )}
              <p className="muted small">
                For a demo, connect the ESP and laptop to your own 2.4 GHz
                hotspot or router. This firmware does not log into a venue’s
                captive portal. The ESP needs a reachable HTTPS address for
                Haven; the laptop’s localhost address cannot be used by the ESP.
              </p>
              <p>
                Selected sensor: {module?.name || "Choose a sensor"} · ID:{" "}
                {module?.id || "—"}
              </p>
              <div className="button-row">
                <button
                  disabled={
                    !module ||
                    !authStatus?.enrolled ||
                    live?.connected ||
                    wifiPairing
                  }
                  onClick={async () => {
                    setWifiPairing(true);
                    setWifiKey(null);
                    setError("");
                    try {
                      await api("/api/home", cfg);
                      const paired = await api("/api/wifi/pair", {
                        moduleId: module?.id,
                      });
                      setWifiKey({
                        moduleId: paired.moduleId,
                        token: paired.deviceToken,
                      });
                      setMessage(
                        "Pairing key created. Copy it into this ESP’s private firmware settings. Any previous key is replaced.",
                      );
                    } catch (error) {
                      setError((error as Error).message);
                    } finally {
                      setWifiPairing(false);
                    }
                  }}
                >
                  Create Wi-Fi pairing key
                </button>
                <button
                  disabled={
                    !module ||
                    live?.connected ||
                    wifiPairing
                  }
                  onClick={() =>
                    action("/api/wifi/reset", { moduleId: module?.id })
                  }
                >
                  Reset Wi-Fi connection
                </button>
                <button
                  disabled={
                    !module ||
                    !authStatus?.enrolled ||
                    live?.connected ||
                    wifiPairing
                  }
                  onClick={async () => {
                    setWifiKey(null);
                    await action("/api/wifi/revoke", { moduleId: module?.id });
                  }}
                >
                  Revoke Wi-Fi key
                </button>
              </div>
              {wifiKey?.moduleId === module?.id && wifiKey && (
                <div>
                  <label>
                    Private pairing key (shown once)
                    <input
                      type="password"
                      readOnly
                      value={wifiKey.token}
                      autoComplete="off"
                    />
                  </label>
                  <div className="button-row">
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(wifiKey.token);
                          setMessage("Pairing key copied.");
                        } catch {
                          setError(
                            "Copy is unavailable. Select and copy the key from the field.",
                          );
                        }
                      }}
                    >
                      Copy pairing key
                    </button>
                    <button onClick={() => setWifiKey(null)}>Hide key</button>
                  </div>
                  <p className="muted small">
                    Stored only in this page while visible. Keep the key
                    private; it authorizes this sensor’s readings and commands.
                  </p>
                </div>
              )}
              <p className="muted small">
                Brief connection faults stop the scan and restart the ESP connection automatically.
                Wait for radar verification, then calibrate the quiet area again.
                After choosing Disconnect, use Reset Wi-Fi connection to allow wireless delivery again.
              </p>
            </section>
            <section className="panel">
              <h2>Prepare an activity session</h2>
              <p>
                After one controlled finite scan, annotate what you observed and
                save it for review and evaluation. These labels are your notes,
                not model predictions. Mixed activities need separate reviewed
                sessions.
              </p>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  const save =
                    (
                      (e.nativeEvent as SubmitEvent)
                        .submitter as HTMLButtonElement | null
                    )?.value !== "export";
                  setSessionSaving(true);
                  setError("");
                  try {
                    const value = await api(
                      save ? "/api/dataset/save" : "/api/dataset/export",
                      {
                        moduleId: module?.id,
                        sessionId: String(form.get("sessionId") || "").trim(),
                        participantId: String(
                          form.get("participantId") || "",
                        ).trim(),
                        label: form.get("label"),
                      },
                    );
                    if (save) setSessionRevision((v) => v + 1);
                    else
                      exportFile(
                        JSON.stringify(value, null, 2),
                        "haven-annotated-session.json",
                      );
                    setMessage(
                      save
                        ? "Recording saved to Haven. Review it in Saved activity recordings below."
                        : "Operator-annotated preview exported. Review labels and keep participant/session splits separate before training.",
                    );
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setSessionSaving(false);
                  }
                }}
              >
                <label>
                  Session identifier
                  <input
                    name="sessionId"
                    required
                    maxLength={100}
                    placeholder="living-room-session-001"
                  />
                </label>
                <label>
                  Participant pseudonym
                  <input
                    name="participantId"
                    required
                    maxLength={100}
                    placeholder="participant-A or empty-room"
                  />
                </label>
                <label>
                  Observed activity
                  <select name="label" defaultValue="unlabelled">
                    <option value="unlabelled">Unlabelled / uncertain</option>
                    <option value="empty-room">Empty room</option>
                    <option value="walking">Walking</option>
                    <option value="standing">Standing</option>
                    <option value="sitting">Sitting</option>
                    <option value="lying-down">Lying down</option>
                  </select>
                </label>
                <button
                  className="primary"
                  type="submit"
                  value="save"
                  disabled={
                    sessionSaving ||
                    mode !== "live" ||
                    !live?.radar_verified ||
                    live.scan_pending ||
                    live.scan_running ||
                    live.monitoring ||
                    !live?.frames?.length
                  }
                >
                  <Download size={16} />
                  Save to Haven
                </button>
                <button
                  type="submit"
                  value="export"
                  disabled={
                    sessionSaving ||
                    mode !== "live" ||
                    !live?.radar_verified ||
                    live.scan_pending ||
                    live.scan_running ||
                    live.monitoring ||
                    !live?.frames?.length
                  }
                >
                  Export annotated session
                </button>
              </form>
              <p className="muted small">
                Finish the scan and stop persistent monitoring first. The export
                retains partial coordinates, module placement and host receipt
                times and overlapping CSI when available. Save before starting another scan or restarting Haven. Labels describe what you observed.
              </p>
            </section>
            <SessionLibrary
              revision={sessionRevision}
              request={api}
              download={exportFile}
            />
            <section className="panel">
              <Wifi />
              <h2>Wi-Fi CSI</h2>
              <p>
                {live?.csi?.connected
                  ? `CSI receiving: ${live.csi.samples} samples · ${live.csi.approx_rate?.toFixed(1)} samples/s · channel ${live.csi.channel} · RSSI ${live.csi.rssi} dBm · ${live.csi.dropped || 0} dropped.`
                  : "No fresh CSI stream is connected."}
              </p>
              <p>{live?.activityEstimate?.enabled
                ? `Experimental activity estimate: ${live.activityEstimate.label?.replace(/-/g, " ")} · ${((live.activityEstimate.model_vote || 0) * 100).toFixed(0)}% model vote · ${live.activityEstimate.branch}. This is a sensor-window estimate, not an identified person or medical reading.`
                : "No live activity estimate is available. A reviewed target model and continuous paired readings are required."}</p>
              <p>Keep the router and sensor fixed. Leave the sensing area still for 30 seconds to calibrate motion changes.</p>
              <button disabled={!live?.csi?.connected || live.csi.motion?.status === "calibrating"} onClick={async () => {
                try { await api("/api/csi/calibrate", {}); }
                catch (error) { alert(error instanceof Error ? error.message : "Calibration could not start"); }
              }}>Calibrate quiet area</button>
              <button disabled={!live?.csi?.samples} onClick={async () => {
                try { exportFile(JSON.stringify(await api("/api/csi/export"), null, 2), "haven-csi-readings.json"); }
                catch (error) { setError(error instanceof Error ? error.message : "CSI export could not complete"); }
              }}>Export CSI readings</button>
              <p>{live?.csi?.motion?.status === "calibrating"
                ? `Keep still: ${live.csi.motion.remaining_seconds} seconds remaining.`
                : live?.csi?.motion?.status === "motion" ? "CSI: motion change detected."
                : live?.csi?.motion?.status === "quiet" ? "CSI: channel is quiet."
                : live?.csi?.motion?.status === "calibration_failed" ? "Not enough continuous samples. Try calibration again."
                : "CSI motion needs a quiet calibration."} This detects channel changes; it does not identify an activity or count people.</p>
              <p>{live?.motionEvidence?.status === "corroborated_motion" ? "Both CSI and radar show motion."
                : live?.motionEvidence?.status === "sources_disagree" ? "CSI and radar show different motion evidence."
                : live?.motionEvidence?.status === "no_motion_evidence" ? "Neither source currently shows motion evidence."
                : "Both calibrated CSI and fresh radar readings are needed to compare motion."}</p>
            </section>
          </>
        )}
        {page === "care" && (
          <>
            <section className="care-banner">
              <Heart size={28} />
              <div>
                <h2>Care built on evidence.</h2>
                <p>
                  The current console preview cannot establish falls, heartbeat,
                  breathing, or a stationary person’s health. These readings
                  remain unavailable.
                </p>
              </div>
            </section>
            {cfg.rooms.map((r) => (
              <section className="panel sensor-card" key={r.id}>
                <Heart />
                <div>
                  <h3>{r.name}</h3>
                  <p>{r.care ? "Care room enabled" : "Care monitoring off"}</p>
                </div>
                <button
                  onClick={() =>
                    setCfg((c) => ({
                      ...c,
                      rooms: c.rooms.map((q) =>
                        q.id === r.id ? { ...q, care: !q.care } : q,
                      ),
                    }))
                  }
                >
                  {r.care ? "Disable care room" : "Enable care room"}
                </button>
              </section>
            ))}

          </>
        )}
        {page === "events" && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Events to review</h2>
              <button
                onClick={() =>
                  exportFile(
                    JSON.stringify(cfg.events, null, 2),
                    "haven-events.json",
                  )
                }
              >
                <Download size={16} />
                Export log
              </button>
            </div>
            {cfg.events.length ? (
              cfg.events.map((e) => (
                <div className="event" key={e.id}>
                  <div className="event-icon">
                    <Shield size={18} />
                  </div>
                  <div>
                    <strong>{e.kind}</strong>
                    <p>
                      {e.room} · {new Date(e.at).toLocaleString()}
                    </p>
                    <span className="tag">
                      {e.source === "recorded"
                        ? "Recorded replay"
                        : "Live preview"}
                    </span>
                  </div>
                  <button
                    disabled={e.acknowledged}
                    onClick={() =>
                      setCfg((c) => ({
                        ...c,
                        events: c.events.map((v) =>
                          v.id === e.id ? { ...v, acknowledged: true } : v,
                        ),
                      }))
                    }
                  >
                    {e.acknowledged ? (
                      <>
                        <Check size={16} />
                        Reviewed
                      </>
                    ) : (
                      "Mark reviewed"
                    )}
                  </button>
                </div>
              ))
            ) : (
              <div className="empty">
                <Shield />
                <h3>Nothing to review yet.</h3>
                <p>
                  Enable Away mode and play a capture to test the event flow.
                </p>
              </div>
            )}
            <p className="muted small">
              These are motion review events, not confirmed intrusions. Remote
              push delivery is not configured.
            </p>
          </section>
        )}
        {page === "setup" && (
          <>
            <EmailSetup />
            <section className="panel">
              <h2>Background notifications</h2>
              <div role="status">
                <p>
                  {!pushStatus
                    ? "Delivery status unavailable"
                    : !pushStatus.configured
                      ? "Server delivery is not configured"
                      : !pushStatus.enrolled
                        ? "Workspace sign-in setup is required"
                        : "Server delivery is configured; device receipt remains unverified"}
                </p>
                {pushStatus && (
                  <p className="muted small">
                    Registered devices in this workspace: {pushStatus.devices} ·
                    Pending: {pushStatus.states.pending || 0} · Accepted by push
                    service: {pushStatus.states.accepted_by_push_service || 0} ·
                    Failed: {pushStatus.states.failed || 0} · Expired:{" "}
                    {pushStatus.states.expired || 0} · Cancelled:{" "}
                    {pushStatus.states.cancelled || 0}
                  </p>
                )}
              </div>

              <p>
                Register this browser for Away review alerts. Server delivery
                configuration, sign-in and a supported secure connection are
                required. No delivery has been verified yet.
              </p>
              <div className="button-row">
                <button
                  onClick={async () => {
                    try {
                      setMessage(await enableBackgroundPush());
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  Enable background notifications
                </button>
                <button
                  onClick={async () => {
                    try {
                      setMessage(await disableBackgroundPush());
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  Disable for this browser
                </button>
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span className="tiny">01 · YOUR SPACE</span>
                  <h2>Bring in your scan.</h2>
                </div>
                <label className="primary upload">
                  <Upload size={16} />
                  Import Polycam export
                  <input
                    type="file"
                    multiple
                    accept=".glb,.gltf,.obj,.bin,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => importScan(e.target.files)}
                  />
                </label>
              </div>
              <p>
                Use a GLB, OBJ, or GLTF with its companion geometry and
                textures. A top-down view is rendered from the mesh. Room
                boundaries and sensor calibration are set below.
              </p>
              {models.length > 0 && (
                <div className="button-row">
                  <label>
                    Active scan
                    <select
                      value={scan?.id}
                      onChange={(e) => {
                        setScan(models.find((m) => m.id === e.target.value));
                        setCfg((c) => ({ ...c, homeModelId: e.target.value }));
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Scan vertical axis
                    <select
                      value={scan?.upAxis || "Y"}
                      onChange={(e) =>
                        updateScan({ upAxis: e.target.value as "Y" | "Z" })
                      }
                    >
                      <option value="Y">Y is up</option>
                      <option value="Z">Z is up</option>
                    </select>
                  </label>
                  <label>
                    Scan floor rotation (degrees)
                    <input
                      type="number"
                      min={-360}
                      max={360}
                      step={1}
                      value={scan?.yaw || 0}
                      onChange={(e) => {
                        const yaw = Number(e.target.value);
                        if (Number.isFinite(yaw) && Math.abs(yaw) <= 360)
                          updateScan({ yaw });
                      }}
                    />
                  </label>
                  <label>
                    Metres per model unit
                    <input
                      type="number"
                      min=".001"
                      max="100"
                      step=".001"
                      value={scan?.scale || 1}
                      onChange={async (e) => {
                        if (!scan) return;
                        const scale = Number(e.target.value);
                        if (scale <= 0 || !Number.isFinite(scale)) return;
                        const next = { ...scan, scale };
                        try {
                          await saveModel(next);
                          setModels(await listModels());
                          setScan(next);
                        } catch (error) {
                          setError((error as Error).message);
                        }
                      }}
                    />
                  </label>
                </div>
              )}
              <p className="muted small">
                {scan
                  ? "Your imported scan supplies the map dimensions. Name rooms and place sensors on its top view below."
                  : "Import your scan to replace the example layout with your space."}
              </p>
              <button
                disabled={!capabilities?.polycam_api_configured}
                onClick={async () => {
                  try {
                    const response = await api("/api/polycam/captures");
                    setPolyCaptures(response.captures || []);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Browse Polycam captures
              </button>
              {polyCaptures.map((c) => (
                <div className="sensor-card" key={c.id}>
                  <span>{c.name}</span>
                  <button
                    onClick={async () => {
                      try {
                        const links = await api(
                          "/api/polycam/artifacts?id=" +
                            encodeURIComponent(c.id),
                        );
                        exportFile(
                          JSON.stringify(links, null, 2),
                          c.name + "-artifact-links.json",
                        );
                        setMessage(
                          "Artifact links exported. Download a model and import it locally. Links expire after one hour.",
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Get export links
                  </button>
                </div>
              ))}
              <a
                href="https://poly.cam/docs/api"
                target="_blank"
                rel="noreferrer"
              >
                Polycam API documentation <ArrowUpRight size={14} />
              </a>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span className="tiny">02 · ROOM BOUNDARIES</span>
                  <h2>Make every room a place.</h2>
                </div>
              </div>
              <p>
                Set boundary points on the scan, close each outline and name the
                room. Saved room details appear below once boundaries are
                defined.
              </p>

              {scan && footprint && (
                <RoomDrawing
                  key={`${scan.id}:${scan.scale}:${scan.upAxis}:${scan.yaw}`}
                  config={cfg}
                  model={scan}
                  footprint={footprint}
                  onApply={(next) => {
                    setCfg(next);
                    setError("");
                    setMessage(
                      "Named rooms saved from the house scan. Review sensor room assignments.",
                    );
                  }}
                />
              )}
              {cfg.rooms
                .filter(
                  (r) =>
                    r.boundary &&
                    r.boundary.length >= 3 &&
                    (!scan ||
                      r.planModelId === scan.id ||
                      r.modelId === scan.id),
                )
                .map((r) => (
                  <div className="defined-room" key={r.id}>
                    <label>
                      Room name
                      <input
                        aria-label={r.name + " name"}
                        value={r.name}
                        onChange={(e) =>
                          setCfg((c) => ({
                            ...c,
                            rooms: c.rooms.map((q) =>
                              q.id === r.id
                                ? { ...q, name: e.target.value }
                                : q,
                            ),
                          }))
                        }
                      />
                    </label>
                    <p className="muted small">
                      {r.boundary!.length} boundary points · Extent{" "}
                      {r.width.toFixed(2)} × {r.depth.toFixed(2)} m ·{" "}
                      {models.find((m) => m.id === r.modelId)?.name ||
                        "Home scan"}
                    </p>
                  </div>
                ))}
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span className="tiny">03 · SENSOR PLACEMENT</span>
                  <h2>A small sensor. A precise position.</h2>
                </div>
                <button onClick={() => setDialog("module")}>
                  <Plus size={16} />
                  Add module
                </button>
              </div>
              <p>
                {scan
                  ? "Where is the sensor installed in this scanned space? Choose a module, then tap its actual location on the GLB top view."
                  : "Import your GLB above to place the sensor on your scanned space, or use the schematic below."}
                Set its orientation: 0° points down the floor plan, 90° points
                right. Confirm room boundaries and model scale above before
                placement.
              </p>
              <p className="muted small">
                Radar coverage: 120° sector, 8 m nominal range at the scan’s
                metre scale. Coverage beyond the displayed scan is cropped;
                walls and mounting affect actual detection.
              </p>
              <select
                aria-label="Module to place"
                value={placing || ""}
                onChange={(e) => setPlacing(e.target.value || null)}
              >
                <option value="">Choose a module to place</option>
                {cfg.modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {scan && (
                <p className="muted small">
                  {footprint
                    ? `Scan extent: ${footprint.width.toFixed(2)} × ${footprint.depth.toFixed(2)} m at the current scale.`
                    : scanState?.error ||
                      "Processing the scan before placement…"}
                  {cfg.modules.length > planModules.length &&
                    " Some sensors need placement on this scan. Select one and tap its installed position; changing the scan, units or alignment requires placement review."}
                  {!mappedRooms.length &&
                    " Room names are unavailable in this file. Placement will save a Scanned space boundary from the GLB; you can name or divide it in Room boundaries."}
                </p>
              )}
              <div
                className="floor-map sensor-scan-map"
                style={{ aspectRatio: `${maxX}/${maxZ}` }}
              >
                {scan && (
                  <Suspense
                    fallback={
                      <p role="status">Processing scan for placement…</p>
                    }
                  >
                    <Scene
                      rooms={planRooms}
                      modules={planModules}
                      tracks={[]}
                      model={scan}
                      plan
                      planBounds={bounds}
                    />
                  </Suspense>
                )}
                <svg
                  className={"placement-map " + (placing ? "placing" : "")}
                  viewBox={planViewBox(maxX, maxZ, bounds.minX, bounds.minZ)}
                  role="img"
                  aria-label="Sensor placement map"
                  onClick={(e) => {
                    if (!placing) return;
                    try {
                      const svg = e.currentTarget,
                        matrix = svg.getScreenCTM();
                      if (!matrix)
                        throw Error("The placement map is not ready yet.");
                      const p = svg.createSVGPoint();
                      p.x = e.clientX;
                      p.y = e.clientY;
                      const q = p.matrixTransform(matrix.inverse());
                      const next = placeModule(
                        cfg,
                        placing,
                        { x: q.x, z: q.y },
                        scan,
                        footprint,
                      );
                      setCfg(next);
                      setError("");
                      const placed = next.modules.find(
                        (m) => m.id === placing,
                      )!;
                      setMessage(
                        "Sensor position saved in " +
                          next.rooms.find((r) => r.id === placed.roomId)!.name,
                      );
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  {mappedRooms.map((r) => (
                    <g key={r.id}>
                      {r.boundary?.length ? (
                        <path d={roomPath(r)} className="room scan-room" />
                      ) : (
                        <>
                          <rect
                            x={r.x}
                            y={r.z}
                            width={r.width}
                            height={r.depth}
                            className={scan ? "room scan-room" : "room"}
                          />
                        </>
                      )}
                      <text x={r.x + 0.2} y={r.z + 0.5} className="room-name">
                        {r.name}
                      </text>
                    </g>
                  ))}
                  {planModules.map((m) => (
                    <RadarDirection
                      key={"direction:" + m.id}
                      module={m}
                      onDirectionChange={(yaw) => {
                        setEditingSensor(m.id);
                        setCfg((c) => ({
                          ...c,
                          modules: c.modules.map((q) =>
                            q.id === m.id ? { ...q, yaw } : q,
                          ),
                        }));
                      }}
                    />
                  ))}
                  {planModules.map((m) => (
                    <circle
                      key={m.id}
                      cx={m.x}
                      cy={m.z}
                      r=".16"
                      className="sensor-icon sensor-action"
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${m.name}`}
                      aria-expanded={editingSensor === m.id}
                      onMouseEnter={() => setEditingSensor(m.id)}
                      onFocus={() => setEditingSensor(m.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSensor(m.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingSensor(m.id);
                        }
                      }}
                    >
                      <title>{`${m.name} · ${cfg.rooms.find((r) => r.id === m.roomId)?.name || "Unassigned"} · height ${m.height} m · yaw ${m.yaw}°. Click to edit or delete.`}</title>
                    </circle>
                  ))}
                </svg>
              </div>
              <p className="muted small">
                Hover, click or tap a sensor to see its details. Drag the dot at
                the end of its direction line to rotate its field of view.
              </p>
              <div className="sensor-selector">
                {cfg.modules.map((m) => (
                  <button
                    key={m.id}
                    aria-expanded={editingSensor === m.id}
                    onClick={() => setEditingSensor(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              {cfg.modules
                .filter((m) => m.id === editingSensor)
                .map((m) => (
                  <div className="sensor-details" key={m.id}>
                    <h3>Sensor details</h3>
                    <label>
                      Device name
                      <input
                        value={m.name}
                        onChange={(e) =>
                          setCfg((c) => ({
                            ...c,
                            modules: c.modules.map((q) =>
                              q.id === m.id
                                ? { ...q, name: e.target.value }
                                : q,
                            ),
                          }))
                        }
                      />
                    </label>
                    <p className="muted small">
                      Device ID: {m.id} · Room:{" "}
                      {cfg.rooms.find((r) => r.id === m.roomId)?.name ||
                        "Unassigned"}
                      <br />
                      Position: {m.x.toFixed(2)}, {m.z.toFixed(2)} m · Port:{" "}
                      {m.port || "Not configured"}
                    </p>
                    <button
                      onClick={() => {
                        setPlacing(m.id);
                        setMessage(
                          "Tap the sensor’s new installed position on the map.",
                        );
                      }}
                    >
                      Move this sensor
                    </button>
                    <div className="module-edit">
                      <strong>{m.name}</strong>
                      <label>
                        Facing direction (°)
                        <input
                          type="number"
                          value={m.yaw}
                          min="-360"
                          max="360"
                          onChange={(e) =>
                            setCfg((c) => ({
                              ...c,
                              modules: c.modules.map((q) =>
                                q.id === m.id
                                  ? { ...q, yaw: Number(e.target.value) }
                                  : q,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Height (m)
                        <input
                          type="number"
                          value={m.height}
                          min="0"
                          max="5"
                          step=".1"
                          onChange={(e) =>
                            setCfg((c) => ({
                              ...c,
                              modules: c.modules.map((q) =>
                                q.id === m.id
                                  ? { ...q, height: Number(e.target.value) }
                                  : q,
                              ),
                            }))
                          }
                        />
                      </label>
                    </div>
                    <button
                      className="delete-device"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Delete ${m.name} from this home? Its connection will close. Saved recordings and activity history will remain.`,
                          )
                        )
                          return;
                        try {
                          await api("/api/disconnect", { moduleId: m.id });
                          const modules = cfg.modules.filter(
                            (q) => q.id !== m.id,
                          );
                          const next = {
                            ...cfg,
                            modules,
                            activeModuleId:
                              cfg.activeModuleId === m.id
                                ? modules[0]?.id
                                : cfg.activeModuleId,
                          };
                          await api("/api/home", next);
                          setCfg(next);
                          setEditingSensor(null);
                          if (placing === m.id) setPlacing(null);
                          setWifiKey(null);
                          setMessage("Device removed from this home.");
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Delete this device
                    </button>
                    <button onClick={() => setEditingSensor(null)}>
                      Close details
                    </button>
                  </div>
                ))}
            </section>
          </>
        )}
        <footer>
          <span>Haven · Research pilot</span>
          <span>
            Partial radar previews · people, activities and vital signs
            unvalidated
          </span>
        </footer>
      </main>
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={"Add " + dialog}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-heading">
              <h2>Add {dialog}</h2>
              <button aria-label="Close dialog" onClick={() => setDialog(null)}>
                ×
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (dialog === "room") submitRoom(e.currentTarget);
                if (dialog === "module") submitModule(e.currentTarget);
              }}
            >
              <label>
                Name
                <input
                  name="name"
                  required
                  maxLength={80}
                  placeholder={dialog === "room" ? "Bedroom" : "Radar 02"}
                />
              </label>
              {dialog === "room" && (
                <div className="form-grid">
                  {["x", "z", "width", "depth"].map((k) => (
                    <label key={k}>
                      {k === "z"
                        ? "Y"
                        : k === "yaw"
                          ? "Facing direction (°)"
                          : k}{" "}
                      (m)
                      <input
                        name={k}
                        type="number"
                        min={k === "width" || k === "depth" ? 0.1 : -50}
                        max="100"
                        required
                        defaultValue={
                          k === "width"
                            ? footprint &&
                              !mappedRooms.some((r) => !r.scanEnvelope)
                              ? footprint.width
                              : 4
                            : k === "depth"
                              ? footprint &&
                                !mappedRooms.some((r) => !r.scanEnvelope)
                                ? footprint.depth
                                : 4
                              : 0
                        }
                        step="any"
                      />
                    </label>
                  ))}
                </div>
              )}
              {dialog === "module" && (
                <>
                  {scan ? (
                    <p className="muted small">
                      Save this module, then tap its installed position on your
                      scan. The room and map coordinates will come from that
                      position.
                    </p>
                  ) : (
                    <label>
                      Room
                      <select name="room">
                        {cfg.rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="form-grid">
                    {(scan
                      ? ["height", "yaw"]
                      : ["x", "z", "height", "yaw"]
                    ).map((k) => (
                      <label key={k}>
                        {k === "z" ? "Y" : k}
                        <input
                          name={k}
                          type="number"
                          min={k === "height" ? 0 : -360}
                          max="360"
                          step=".1"
                          required
                          defaultValue={k === "height" ? 1.2 : 0}
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    Serial port
                    <input name="port" defaultValue={port} />
                  </label>
                </>
              )}
              <button className="primary">
                <Plus size={16} />
                Save {dialog}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
