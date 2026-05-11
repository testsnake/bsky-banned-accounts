const BSKY_API = "https://api.bsky.app";

interface Label {
  src: string;
  uri: string;
  cid?: string;
  val: string;
  neg?: boolean;
  cts: string;
  exp?: string;
  sig?: unknown;
}

interface QueryLabelsResponse {
  labels: Label[];
  cursor?: string;
}

async function resolveServiceUrl(did: string): Promise<string> {
  let didDoc: { service?: { id: string; type: string; serviceEndpoint: string }[] };

  if (did.startsWith("did:plc:")) {
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) throw new Error(`Failed to resolve DID ${did}: ${res.statusText}`);
    didDoc = await res.json();
  } else if (did.startsWith("did:web:")) {
    const host = did.replace("did:web:", "");
    const res = await fetch(`https://${host}/.well-known/did.json`);
    if (!res.ok) throw new Error(`Failed to resolve DID ${did}: ${res.statusText}`);
    didDoc = await res.json();
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  const services = didDoc.service ?? [];

  const labelerService = services.find(
    (s) => s.type === "AtprotoLabeler" || s.id === "#atproto_labeler"
  );
  if (labelerService) return labelerService.serviceEndpoint;

  const pdsService = services.find(
    (s) => s.type === "AtprotoPersonalDataServer" || s.id === "#atproto_pds"
  );
  if (pdsService) return pdsService.serviceEndpoint;

  return BSKY_API;
}

async function fetchAllLabels(
  serviceUrl: string,
  sourceDid: string,
  subjectDid: string
): Promise<Label[]> {
  const allLabels: Label[] = [];
  let cursor: string | undefined;
  let page = 1;

  console.log(`querying ${serviceUrl}`);

  do {
    const url = new URL(`${serviceUrl}/xrpc/com.atproto.label.queryLabels`);
    url.searchParams.append("sources", sourceDid);
    url.searchParams.append("uriPatterns", subjectDid);
    url.searchParams.set("limit", "250");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`queryLabels failed (HTTP ${res.status}): ${body}`);
    }

    const data: QueryLabelsResponse = await res.json();
    const pageLabels = data.labels ?? [];

    allLabels.push(...pageLabels);
    cursor = data.cursor;

    console.log(`page ${page}: ${pageLabels.length} labels (total: ${allLabels.length})`);
    page++;
  } while (cursor);

  return allLabels;
}

function printLabels(labels: Label[], sourceDid: string, subjectDid: string) {
  if (labels.length === 0) {
    console.log("no labels found");
    return;
  }

  console.log(`\nlabeler : ${sourceDid}`);
  console.log(`subject : ${subjectDid}`);
  console.log(`total   : ${labels.length} label event(s)\n`);

  for (const label of labels) {
    const type = label.neg ? "negation" : "label";
    const expiry = label.exp ? `  exp: ${label.exp}` : "";
    console.log(`${type}  val="${label.val}"  cts=${label.cts}${expiry}`);
    if (label.uri !== subjectDid) {
      console.log(`  uri: ${label.uri}`);
    }
  }

  const negated = new Set(labels.filter((l) => l.neg).map((l) => l.val));
  const uniqueActive = [
    ...new Set(labels.filter((l) => !l.neg && !negated.has(l.val)).map((l) => l.val)),
  ];

  console.log(
    `\nnet active: ${uniqueActive.length > 0 ? uniqueActive.map((v) => `"${v}"`).join(", ") : "none"}`
  );
}

async function main() {
  const [, , sourceDid, subjectDid] = process.argv;

  if (!sourceDid || !subjectDid) {
    console.error("usage: tsx findLabeler.ts <source-did> <subject-did>");
    process.exit(1);
  }

  console.log(`resolving service URL for ${sourceDid}`);
  let serviceUrl: string;
  try {
    serviceUrl = await resolveServiceUrl(sourceDid);
    console.log(`service URL: ${serviceUrl}`);
  } catch (err) {
    console.warn(`could not resolve service URL (${(err as Error).message}), falling back to ${BSKY_API}`);
    serviceUrl = BSKY_API;
  }

  const labels = await fetchAllLabels(serviceUrl, sourceDid, subjectDid);
  printLabels(labels, sourceDid, subjectDid);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});