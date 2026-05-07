import { logger } from "./logger";

const KNOWN_DIDS: Record<string, string> = {
    "did:plc:ar7c4by46qjdydhdevvrndac": "moderation.bsky.app",
    "did:plc:d2mkddsbmnrgr3domzg5qexf": "moderation.blacksky.app",
};

export async function getAccountAgeAndHandle(did: string): Promise<{ age: number | null; handle: string | null }> {
    if (did in KNOWN_DIDS) {
        return { age: null, handle: KNOWN_DIDS[did] };
    }

    if (!did.startsWith("did:plc:")) {
        return { age: null, handle: did };
    }

    try {
        const res = await fetch(`https://plc.directory/${did}/log/audit`);

        if (!res.ok) {
            console.error(`Failed to fetch PLC log for ${did}: HTTP ${res.status}`);
            return { age: null, handle: null };
        }

        const log = await res.json();

        if (!Array.isArray(log) || log.length === 0) {
            return { age: null, handle: null };
        }

        let ageMs: number | null = null;
        // log[0] is the genesis operation (the oldest).
        if (log[0].createdAt) {
            const createdAt = new Date(log[0].createdAt);
            ageMs = Date.now() - createdAt.getTime();
        }

        let handle: string | null = null;
        // Start at the end (the newest) and work backwards to find the current handle
        for (let i = log.length - 1; i >= 0; i--) {
            // Look for the operation data whether it's wrapped in .operation or at the root
            const operationData = log[i].operation || log[i];
            const aliases = operationData.alsoKnownAs;

            if (aliases && Array.isArray(aliases) && aliases.length > 0) {
                // Strip the 'at://' prefix and break out of the loop
                handle = aliases[0].replace("at://", "");
                break;
            }
        }

        return { age: ageMs, handle };
    } catch (error) {
        console.error(`Failed to fetch or parse PLC log for ${did}:`, error);
        return { age: null, handle: null };
    }
}

export function formatDuration(ms: number): string {
    if (ms < 0) return "unknown time";
    if (ms < 60000) return "less than a minute"; // Less than 1 minute

    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((ms / 1000 / 60) % 60);

    const parts = [];

    if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
    if (hours > 0 && days < 7) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (minutes > 0 && days === 0 && hours === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);

    return parts.join(", ");
}
