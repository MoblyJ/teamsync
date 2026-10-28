// LAN discovery via UDP broadcast beacons — zero dependencies.
// The server broadcasts a small JSON beacon every few seconds; any installed
// copy of the CLI can listen and find servers on the local network.
// Broadcasts may be filtered on some networks/WSL setups — discovery is a
// convenience, never a requirement (explicit --server always works).
import dgram from "node:dgram";

export const DISCOVERY_PORT = Number(process.env.TEAMSYNC_DISCOVERY_PORT ?? 41733);

export interface Beacon {
  type: "teamsync-server";
  name: string;
  port: number;
  teams: number;
}

/** A beacon plus the address it arrived from (used to build server URLs). */
export interface DiscoveredServer extends Beacon {
  address: string;
}

export interface BeaconHandle {
  stop(): Promise<void>;
}

/** Broadcast the beacon on the LAN. Best-effort: failures are swallowed. */
export function startBeacon(getBeacon: () => Beacon, intervalMs = 3000): BeaconHandle {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let timer: NodeJS.Timeout | undefined;
  const payload = () => Buffer.from(JSON.stringify(getBeacon()));

  const emit = () => {
    try {
      socket.send(payload(), 0, payload().length, DISCOVERY_PORT, "255.255.255.255");
    } catch {
      // Broadcast unsupported on this network — explicit --server still works.
    }
    try {
      // Loopback copy so same-host discovery always works.
      socket.send(payload(), 0, payload().length, DISCOVERY_PORT, "127.0.0.1");
    } catch {
      /* ignore */
    }
  };

  socket.bind(() => {
    socket.setBroadcast(true);
    emit();
    timer = setInterval(emit, intervalMs);
    timer.unref?.();
  });

  return {
    stop: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}

/** Listen for beacons for `durationMs`, returning unique servers found. */
export async function discoverServers(durationMs = 2500): Promise<DiscoveredServer[]> {
  const seen = new Map<string, DiscoveredServer>();
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(DISCOVERY_PORT, () => resolve());
  });

  return new Promise<DiscoveredServer[]>((resolve) => {
    const finish = () => {
      socket.close();
      resolve([...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    };
    const timer = setTimeout(finish, durationMs);
    timer.unref?.();
    socket.on("message", (msg, rinfo) => {
      try {
        const beacon = JSON.parse(msg.toString("utf8")) as Beacon;
        if (beacon.type === "teamsync-server" && typeof beacon.port === "number" && typeof beacon.name === "string") {
          seen.set(`${beacon.name}:${beacon.port}`, { ...beacon, address: rinfo.address });
        }
      } catch {
        // Not our beacon; ignore.
      }
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
