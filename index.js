const GAME_NAME = "Harpers";
const TAG_LINE = "KR1";
const REGION = "asia";

const MAX_STORED_MATCHES = 20;
const MATCH_LOOKBACK = 20;
const SCHEMA_VERSION = 9;
const MAX_HISTORY_MATCHES = 300;
const RAW_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const SYNC_BATCH_SIZE = 5;

const GITHUB_BRANCH = "main";
const GITHUB_FILE_PATH = "recent.json";

const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        service: "Harpers TFT Tracker",
        status: "ok",
        player: `${GAME_NAME}#${TAG_LINE}`,
        schema_version: SCHEMA_VERSION,
        endpoints: ["/health", "/latest", "/recent", "/recent?limit=5", "/analysis"]
      });
    }

    if (url.pathname === "/health") {
      return json(await getHealth(env));
    }

    if (url.pathname === "/latest") {
      const latest = await env.TFT_KV.get("latest");

      if (!latest) {
        return json(
          {
            status: "waiting",
            message: "아직 저장된 TFT 경기가 없습니다."
          },
          404
        );
      }

      return json(sanitizeMatchForPublic(JSON.parse(latest)));
    }

    if (url.pathname === "/recent") {
      let limit = Number(url.searchParams.get("limit") || 10);

      if (!Number.isFinite(limit)) limit = 10;

      limit = Math.max(
        1,
        Math.min(MAX_STORED_MATCHES, Math.floor(limit))
      );

      const matches = await getRecentMatches(env, limit);

      return json({
        player: `${GAME_NAME}#${TAG_LINE}`,
        count: matches.length,
        schema_version: SCHEMA_VERSION,
        matches: matches.map(sanitizeMatchForPublic)
      });
    }

    if (url.pathname === "/analysis") {
      const rows = await getHistoryRows(env);
      return json(buildHistoryAnalysis(rows));
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncMatches(env));
  }
};

async function syncMatches(env) {
  const previous = JSON.parse(await env.TFT_KV.get("sync_status") || "{}");
  const state = { ...previous, schema_version: SCHEMA_VERSION,
    last_attempt_at: new Date().toISOString(), status: "running", error: null,
    stage: "riot_account", processed_count: 0, pending_count: null };
  try {
    const retryAt = Number(await env.TFT_KV.get("riot_retry_after") || 0);
    if (Date.now() < retryAt) {
      state.status = "rate_limited";
      state.retry_after = new Date(retryAt).toISOString();
      return;
    }
    state.retry_after = null;
    const puuid = await getPuuid(env);
    state.stage = "riot_match_list";

    const idsUrl =
      `https://${REGION}.api.riotgames.com` +
      `/tft/match/v1/matches/by-puuid/` +
      `${encodeURIComponent(puuid)}/ids` +
      `?start=0&count=${MATCH_LOOKBACK}`;

    const matchIds = await riotFetch(idsUrl, env);
    if (!Array.isArray(matchIds)) throw new Error("Invalid match list");
    state.last_riot_check_at = new Date().toISOString();
    state.latest_discovered_match_id = matchIds[0] ?? null;

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      console.log("최근 TFT 경기 없음");
      state.status = "ok";
      state.pending_count = 0;
      return;
    }

    let recentIds = await getStoredRecentIds(env);
    const matchesToProcess = [];

    for (const matchId of matchIds) {
      const existingRaw = await env.TFT_KV.get(`match:${matchId}`);

      if (!existingRaw) {
        matchesToProcess.push(matchId);
        continue;
      }

      try {
        const existing = JSON.parse(existingRaw);

        if (existing.schema_version !== SCHEMA_VERSION) {
          matchesToProcess.push(matchId);
          continue;
        }

        if (
          !existing.me ||
          !Array.isArray(existing.lobby) ||
          existing.lobby.length === 0
        ) {
          matchesToProcess.push(matchId);
        }
      } catch {
        matchesToProcess.push(matchId);
      }
    }

    let newestResult = null;
    state.pending_count = matchesToProcess.length;
    state.stage = "riot_match_details";

    if (matchesToProcess.length > 0) {
      console.log(`재수집/신규 경기 ${matchesToProcess.length}개`);

      // Bound API requests per run. Newest first; older upgrades follow later.

      for (const matchId of matchesToProcess.slice(0, SYNC_BATCH_SIZE)) {
        const matchUrl =
          `https://${REGION}.api.riotgames.com` +
          `/tft/match/v1/matches/` +
          `${encodeURIComponent(matchId)}`;

        const archived = await env.TFT_KV.get(`raw_match:${matchId}`);
        const match = archived
          ? JSON.parse(archived).response
          : await riotFetch(matchUrl, env);
        if (!match?.info || !Array.isArray(match.info.participants) ||
            !match.info.participants.some(p => p.puuid === puuid)) {
          throw new Error(`Invalid match payload: ${matchId}`);
        }
        const dictionary = await getKoreanDictionary(env, match.info.game_version);

        // Raw responses never enter a public endpoint or GitHub mirror.
        if (!archived) {
          await env.TFT_KV.put(`raw_match:${matchId}`, JSON.stringify({
            fetched_at: new Date().toISOString(),
            response: match
          }), { expirationTtl: RAW_RETENTION_SECONDS });
        }

        const result = buildMatchResult(
          match,
          matchId,
          puuid,
          dictionary
        );
        result.review_evidence = buildReviewEvidence(result);

        // Checkpoint the compact history before marking the match processed.
        await saveHistoryRow(env, result);
        await env.TFT_KV.put(
          `match:${matchId}`,
          JSON.stringify(result)
        );
        state.processed_count++;
        state.pending_count--;

        recentIds = [...new Set([...matchIds, ...recentIds])]
          .slice(0, MAX_STORED_MATCHES);
        await env.TFT_KV.put("recent_match_ids", JSON.stringify(recentIds));

        if (matchId === matchIds[0]) {
          newestResult = result;
        }

        console.log(
          `저장 완료 ${matchId} / ${result.me?.placement ?? "?"}위`
        );
        // KV limits writes to the same history/index key to one per second.
        await new Promise(resolve => setTimeout(resolve, 1100));
      }

      await env.TFT_KV.put(
        "recent_match_ids",
        JSON.stringify(recentIds)
      );

      if (newestResult) {
        await env.TFT_KV.put(
          "latest",
          JSON.stringify(newestResult)
        );
      } else {
        const latestRaw = await env.TFT_KV.get(`match:${matchIds[0]}`);

        if (latestRaw) {
          await env.TFT_KV.put("latest", latestRaw);
        }
      }

      await env.TFT_KV.put("last_match_id", matchIds[0]);
    } else {
      console.log(`새 경기 없음 ${matchIds[0]}`);
    }

    state.stage = "github_mirror";
    validateGithubConfig(env);
    await maybePublishGithubMirror(env, matchIds[0]);
    state.last_mirror_check_at = new Date().toISOString();
    state.status = state.pending_count ? "backfilling" : "ok";

    console.log(`동기화 완료 ${matchIds[0]}`);
  } catch (error) {
    state.status = "error";
    state.error = { stage: state.stage, message: String(error?.message || "Sync failed").slice(0, 180),
      http_status: error?.httpStatus ?? null };
    console.error(
      `TFT sync error message: ${error?.message ?? String(error)}`
    );

    console.error(
      `TFT sync error stack: ${error?.stack ?? "no stack"}`
    );
  } finally {
    state.finished_at = new Date().toISOString();
    if (state.status === "ok" || state.status === "backfilling") state.last_success_at = state.finished_at;
    await env.TFT_KV.put("sync_status", JSON.stringify(state));
    // A successful API check remains visible even when no new match exists.
    try {
      validateGithubConfig(env);
      await upsertGithubFile(env, "health.json", JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("Health mirror unavailable", error?.httpStatus ?? "unknown");
    }
  }
}

async function getPuuid(env) {
  let puuid = await env.TFT_KV.get("puuid");

  if (puuid) return puuid;

  const url =
    `https://${REGION}.api.riotgames.com` +
    `/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(GAME_NAME)}/` +
    `${encodeURIComponent(TAG_LINE)}`;

  const account = await riotFetch(url, env);

  if (!account.puuid) {
    throw new Error("PUUID 조회 실패");
  }

  puuid = account.puuid;

  await env.TFT_KV.put("puuid", puuid);

  return puuid;
}

function buildMatchResult(
  match,
  matchId,
  myPuuid,
  dictionary
) {
  const participants = match.info?.participants ?? [];

  const players = participants
    .map(player =>
      buildParticipant(player, myPuuid, dictionary)
    )
    .sort(
      (a, b) =>
        (a.placement ?? 99) -
        (b.placement ?? 99)
    );

  const me = players.find(p => p.is_me) ?? null;

  return {
    schema_version: SCHEMA_VERSION,
    player: `${GAME_NAME}#${TAG_LINE}`,
    match_id: matchId,
    synced_at: new Date().toISOString(),
    dictionary: { source: dictionary.source, version: dictionary.version,
      patch_verified: dictionary.patch_verified, available: dictionary.available },
    review_status: { collected: true, analysis_status: "evidence_prepared",
      notification_requested: null, delivery_confirmed: null,
      delivery_tracking: "not_available_from_chatgpt" },

    game: {
      datetime:
        match.info?.game_datetime
          ? new Date(match.info.game_datetime).toISOString()
          : null,

      length_seconds:
        match.info?.game_length ?? null,

      queue_id:
        match.info?.queue_id ?? null,

      set_number:
        match.info?.tft_set_number ?? null,

      set_core_name:
        match.info?.tft_set_core_name ?? null,

      game_type:
        match.info?.tft_game_type ?? null,

      game_version:
        match.info?.game_version ?? null
    },

    me,
    lobby: players
  };
}

function buildParticipant(
  participant,
  myPuuid,
  dictionary
) {
  const augments = extractAugments(
    participant,
    dictionary
  );

  const relatedFields = {};

  for (const [key, value] of Object.entries(participant)) {
    const k = key.toLowerCase();

    if (
      k.includes("augment") ||
      k.includes("skill") ||
      k.includes("perk")
    ) {
      relatedFields[key] = value;
    }
  }

  return {
    is_me:
      participant.puuid === myPuuid,

    riot_id: {
      game_name:
        participant.riotIdGameName ?? null,

      tagline:
        participant.riotIdTagline ?? null
    },

    placement:
      participant.placement ?? null,

    level:
      participant.level ?? null,

    last_round:
      participant.last_round ?? null,

    gold_left:
      numericOrNull(participant.gold_left),

    time_eliminated_seconds:
      numericOrNull(participant.time_eliminated),

    data_quality: {
      source: "riot_match_result",
      timeline_available: false,
      missing_fields: ["gold_left", "time_eliminated", "last_round", "level",
        "placement", "total_damage_to_players", "players_eliminated"]
        .filter(key => numericOrNull(participant[key]) === null),
      augments_present: Array.isArray(participant.augments),
      missions_present: participant.missions != null,
      missions_interpretation: "unverified_not_used"
    },

    players_eliminated:
      numericOrNull(participant.players_eliminated),

    total_damage_to_players:
      numericOrNull(participant.total_damage_to_players),

    augments,

    debug_augment: {
      raw_augments:
        participant.augments ?? null,

      skill_tree:
        participant.skill_tree ?? null,

      related_fields:
        relatedFields
    },

    traits:
      (participant.traits ?? [])
        .filter(
          trait =>
            (trait.tier_current ?? 0) > 0 ||
            (trait.style ?? 0) > 0
        )
        .map(trait => ({
          id: trait.name,

          name_ko:
            translateName(
              dictionary.traits,
              trait.name
            ),

          num_units:
            numericOrNull(trait.num_units),

          tier_current:
            numericOrNull(trait.tier_current),

          tier_total:
            trait.tier_total ?? 0,

          style:
            trait.style ?? 0
        })),

    units:
      (participant.units ?? [])
        .map(unit => ({
          id:
            unit.character_id ?? "",

          name_ko:
            translateName(
              dictionary.champions,
              unit.character_id
            ),

          star:
            numericOrNull(unit.tier),

          classification: dictionary.unit_metadata?.[unit.character_id]?.classification ?? "unknown",
          classification_source: dictionary.unit_metadata?.[unit.character_id] ? "riot_ddragon_shop_entry" : null,

          rarity:
            unit.rarity ?? null,

          items:
            extractItems(unit, dictionary)
        }))
  };
}

function extractItems(unit, dictionary) {
  let ids = [];

  if (
    Array.isArray(unit.itemNames) &&
    unit.itemNames.length > 0
  ) {
    ids = unit.itemNames;
  } else if (
    Array.isArray(unit.items)
  ) {
    ids = unit.items;
  }

  return ids.map(id => ({
    id: String(id),
    category: "unverified",
    name_ko:
      translateName(
        dictionary.items,
        String(id)
      )
  }));
}

function extractAugments(
  participant,
  dictionary
) {
  const ids = [];

  if (Array.isArray(participant.augments)) {
    for (const value of participant.augments) {
      if (
        typeof value === "string" &&
        value
      ) {
        ids.push(value);
      }
    }
  }

  for (
    const [key, value]
    of Object.entries(participant)
  ) {
    if (
      key === "augments" ||
      !key.toLowerCase().includes("augment")
    ) {
      continue;
    }

    collectStrings(value, ids);
  }

  return [...new Set(ids)].map(id => ({
    id,

    name_ko:
      translateName(
        dictionary.augments,
        id
      )
  }));
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const x of value) {
      collectStrings(x, output);
    }

    return;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    for (const x of Object.values(value)) {
      collectStrings(x, output);
    }
  }
}

async function getKoreanDictionary(env, gameVersion) {
  const patch = knownPatch(gameVersion);
  let versions;
  try {
    versions = await fetchJson(DDRAGON_BASE + "/api/versions.json");
    if (!Array.isArray(versions)) throw new Error("Invalid versions");
    const version = patch ? versions.find(v => v.startsWith(patch + ".")) : versions[0];
    if (!version) throw new Error("No matching Data Dragon version");
    const cacheKey = `riot_dictionary_v9:${version}`;
    const cached = await env.TFT_KV.get(cacheKey);
    if (cached) return {...JSON.parse(cached), patch_verified: Boolean(patch)};
    const types = ["champion", "trait", "item", "augments"];
    const docs = await Promise.all(types.map(type =>
      fetchJson(`${DDRAGON_BASE}/cdn/${version}/data/ko_KR/tft-${type}.json`)
        .catch(() => null)));
    const maps = docs.map(doc => buildNameMap(doc?.data));
    const unit_metadata = {};
    for (const [path, unit] of Object.entries(docs[0]?.data || {})) {
      if (unit.id && path.includes("/Shop/") && unit.cost > 0) {
        unit_metadata[unit.id] = {classification: "shop_unit"};
      }
    }
    const dictionary = {source: "Riot Data Dragon", version,
      available: docs.some(Boolean), patch_verified: Boolean(patch),
      champions: maps[0], traits: maps[1], items: maps[2], augments: maps[3], unit_metadata};
    // Do not cache incomplete downloads for a whole day.
    if (docs.every(Boolean)) await env.TFT_KV.put(cacheKey, JSON.stringify(dictionary), {expirationTtl: 86400});
    return dictionary;
  } catch {
    return {source: "Riot Data Dragon", version: null, patch_verified: false,
      available: false, champions: {}, traits: {}, items: {}, augments: {}, unit_metadata: {}};
  }
}

function knownPatch(version) {
  if (typeof version !== "string" || version.includes("?")) return null;
  return version.match(/(?:Version\s+)?(\d+\.\d+)(?:\.|\s|$)/i)?.[1] ?? null;
}

async function fetchJson(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Static data HTTP ${response.status}`);
  return response.json();
}

function buildNameMap(data) {
  const map = {};
  for (const obj of Object.values(data || {})) {
    if (!obj || typeof obj !== "object") continue;
    const id = typeof obj.id === "string" || typeof obj.id === "number" ? String(obj.id) : null;
    if (id && typeof obj.name === "string") map[id] = obj.name;
  }
  return map;
}

function translateName(dictionary, id) {
  if (id === undefined || id === null) return "";
  const key = String(id).trim();
  // No digit stripping, cross-set aliases, or guesses from a display name.
  return dictionary?.[key] ?? key;
}

function walkObject(value, callback) {
  if (
    value === null ||
    value === undefined
  ) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkObject(item, callback);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  callback(value);

  for (
    const child
    of Object.values(value)
  ) {
    walkObject(child, callback);
  }
}

function mergeMaps(primary, secondary) {
  return {
    ...(secondary ?? {}),
    ...(primary ?? {})
  };
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

async function getRecentMatches(env, limit) {
  const ids = await getStoredRecentIds(env);
  const matches = [];

  for (
    const id
    of ids.slice(0, limit)
  ) {
    const raw = await env.TFT_KV.get(`match:${id}`);

    if (!raw) continue;

    try {
      matches.push(JSON.parse(raw));
    } catch {}
  }

  return matches;
}

async function getStoredRecentIds(env) {
  const raw =
    await env.TFT_KV.get("recent_match_ids");

  if (!raw) {
    const old =
      await env.TFT_KV.get("last_match_id");

    return old ? [old] : [];
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function riotFetch(url, env) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "X-Riot-Token":
        env.RIOT_API_KEY
    }
  });

  const text = await response.text();

  if (!response.ok) {
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
      await env.TFT_KV.put("riot_retry_after", String(Date.now() + delay * 1000));
    }
    const error = new Error(`Riot API HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }

  return JSON.parse(text);
}

function validateGithubConfig(env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN 없음");
  }

  if (!env.GITHUB_OWNER) {
    throw new Error("GITHUB_OWNER 없음");
  }

  if (!env.GITHUB_REPO) {
    throw new Error("GITHUB_REPO 없음");
  }
}

async function maybePublishGithubMirror(
  env,
  latestMatchId
) {
  const matches = await getRecentMatches(env, MAX_STORED_MATCHES);
  const history = buildHistoryAnalysis(await getHistoryRows(env));
  const publicMatches = matches.map(sanitizeMatchForPublic);
  const comparisons = buildSimilarBoards(matches);
  const fingerprint = JSON.stringify({publicMatches, history, comparisons});
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  const marker = `${SCHEMA_VERSION}:${latestMatchId}:` +
    Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");

  const oldMarker =
    await env.TFT_KV.get("github_mirror_marker");

  if (oldMarker === marker) {
    console.log("GitHub mirror 변경 없음");
    return;
  }

  const payload = {
    player:
      `${GAME_NAME}#${TAG_LINE}`,

    generated_at:
      new Date().toISOString(),

    schema_version:
      SCHEMA_VERSION,

    latest_match_id:
      latestMatchId,

    count:
      publicMatches.length,

    history_analysis: history,
    similar_boards: comparisons,
    health_url: "health.json",
    review_contract: { required_sections: ["deck_direction", "opponents", "positioning", "items"],
      timeline_available: false, delivery_confirmation_available: false,
      instruction: "Data collection and evidence preparation do not confirm notification delivery." },

    matches:
      publicMatches
  };

  await upsertGithubFile(
    env,
    GITHUB_FILE_PATH,
    JSON.stringify(payload, null, 2)
  );

  await env.TFT_KV.put(
    "github_mirror_marker",
    marker
  );

  console.log("GitHub mirror 갱신 완료");
}

function sanitizeMatchForPublic(match) {
  return {
    schema_version:
      match.schema_version,

    match_id:
      match.match_id,

    synced_at:
      match.synced_at,
    dictionary: match.dictionary ?? null,
    review_status: match.review_status ?? null,
    review_evidence: match.review_evidence ?? null,

    game:
      match.game,

    me:
      sanitizeParticipant(
        match.me,
        true
      ),

    lobby:
      Array.isArray(match.lobby)
        ? match.lobby.map(
            player =>
              sanitizeParticipant(
                player,
                Boolean(player?.is_me)
              )
          )
        : []
  };
}

function sanitizeParticipant(
  player,
  includeDebug = false
) {
  if (!player) return null;

  const output = {
    is_me:
      Boolean(player.is_me),

    placement:
      player.placement ?? null,

    level:
      player.level ?? null,

    last_round:
      player.last_round ?? null,

    gold_left:
      player.gold_left ?? null,

    time_eliminated_seconds:
      player.time_eliminated_seconds ?? null,

    data_quality:
      player.data_quality ?? null,

    players_eliminated:
      player.players_eliminated ?? null,

    total_damage_to_players:
      player.total_damage_to_players ?? null,

    augments:
      player.augments ?? [],

    traits:
      player.traits ?? [],

    units:
      player.units ?? []
  };

  // Arbitrary debug/mission fields are private: only explicit fields are public.

  return output;
}

async function upsertGithubFile(
  env,
  path,
  text
) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  const encodedPath =
    path
      .split("/")
      .map(encodeURIComponent)
      .join("/");

  const url =
    `https://api.github.com/repos/` +
    `${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/` +
    `contents/${encodedPath}`;

  let sha = null;

  const getResponse =
    await fetch(
      `${url}?ref=${GITHUB_BRANCH}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: githubHeaders(env)
      }
    );

  if (getResponse.status === 200) {
    const existing =
      await getResponse.json();

    sha = existing.sha ?? null;
  } else if (
    getResponse.status !== 404
  ) {
    throw new Error(
      `GitHub GET HTTP ${getResponse.status}`
    );
  }

  const body = {
    message:
      `Update TFT data ${new Date().toISOString()}`,

    content:
      utf8ToBase64(text),

    branch:
      GITHUB_BRANCH
  };

  if (sha) body.sha = sha;

  const putResponse =
    await fetch(
      url,
      {
        method: "PUT",
        signal: AbortSignal.timeout(15000),
        headers: githubHeaders(env),
        body: JSON.stringify(body)
      }
    );

  if (!putResponse.ok) {
    throw new Error(
      `GitHub PUT HTTP ${putResponse.status}`
    );
  }
}

function githubHeaders(env) {
  return {
    "Authorization":
      `Bearer ${env.GITHUB_TOKEN}`,

    "Accept":
      "application/vnd.github+json",

    "X-GitHub-Api-Version":
      "2022-11-28",

    "User-Agent":
      "Harpers-TFT-Tracker",

    "Content-Type":
      "application/json"
  };
}

function utf8ToBase64(text) {
  const bytes =
    new TextEncoder().encode(text);

  let binary = "";
  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk =
      bytes.subarray(
        i,
        i + chunkSize
      );

    binary +=
      String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function getHistoryRows(env) {
  const raw = await env.TFT_KV.get("history_rows_v1");
  if (!raw) return [];
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("Invalid history rows");
  return rows;
}

function buildHistoryRow(match) {
  const me = match.me;
  if (!me) return null;
  const units = me.units ?? [];
  const opponents = (match.lobby ?? []).filter(p => !p.is_me);
  const keyTraits = (me.traits ?? []).filter(t => t.num_units > 0)
    .sort((a, b) => b.num_units - a.num_units || a.id.localeCompare(b.id))
    .slice(0, 2).map(t => ({id: t.id, name_ko: t.name_ko}));
  return {
    match_id: match.match_id,
    datetime: match.game.datetime ?? match.synced_at,
    // Exact build version prevents accidentally pooling different patches.
    game_version: match.game.game_version,
    set_number: match.game.set_number,
    set_core_name: match.game.set_core_name,
    queue_id: match.game.queue_id,
    game_type: match.game.game_type,
    schema_version: match.schema_version,
    placement: numericOrNull(me.placement),
    level: numericOrNull(me.level),
    last_round: numericOrNull(me.last_round),
    gold_left: numericOrNull(me.gold_left),
    time_eliminated_seconds: numericOrNull(me.time_eliminated_seconds),
    total_damage_to_players: numericOrNull(me.total_damage_to_players),
    players_eliminated: numericOrNull(me.players_eliminated),
    key_traits: keyTraits,
    unit_count: units.length,
    three_star_units: units.filter(u => u.star === 3).length,
    equipped_item_entries: units.reduce((n, u) => n + u.items.length, 0),
    // These are occupied item entries, NOT counts of completed items.
    units_with_three_item_entries: units.filter(u => u.items.length >= 3).length,
    contested_units: units.map(u => ({
      id: u.id,
      name_ko: u.name_ko,
      opposing_final_boards: opponents.filter(p =>
        (p.units ?? []).some(other => other.id === u.id)).length
    })).filter(u => u.opposing_final_boards > 0)
  };
}

async function saveHistoryRow(env, match) {
  const row = buildHistoryRow(match);
  if (!row) throw new Error(`Target participant missing: ${match.match_id}`);
  const rows = await getHistoryRows(env);
  const next = [row, ...rows.filter(r => r.match_id !== row.match_id)]
    .sort((a, b) => b.datetime.localeCompare(a.datetime))
    .slice(0, MAX_HISTORY_MATCHES);
  await env.TFT_KV.put("history_rows_v1", JSON.stringify(next));
}

function summarizeRows(rows) {
  const values = key => rows.map(r => r[key]).filter(v => numericOrNull(v) !== null);
  const metric = key => {
    const samples = values(key);
    return {sample_count: samples.length, mean: samples.length
      ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length * 100) / 100
      : null};
  };
  const placements = values("placement").filter(p => p >= 1 && p <= 8);
  const bottom = rows.filter(r => r.placement >= 5 && r.placement <= 8);
  const knownGoldBottom = bottom.filter(r => numericOrNull(r.gold_left) !== null);
  return {
    match_count: rows.length,
    small_sample: rows.length < 20,
    average_placement: metric("placement"),
    top4_rate: placements.length ? placements.filter(p => p <= 4).length / placements.length : null,
    first_rate: placements.length ? placements.filter(p => p === 1).length / placements.length : null,
    top4_denominator: placements.length,
    gold_left: metric("gold_left"),
    last_round: metric("last_round"),
    time_eliminated_seconds: metric("time_eliminated_seconds"),
    total_damage_to_players: metric("total_damage_to_players"),
    level: metric("level"),
    three_star_units: metric("three_star_units"),
    bottom4_gold_review: {
      threshold: 20,
      known_gold_matches: knownGoldBottom.length,
      matches_at_or_above_threshold: knownGoldBottom.filter(r => r.gold_left >= 20).length,
      interpretation: "review_signal_not_proof_of_misplay"
    }
  };
}

function buildHistoryAnalysis(rows) {
  const groups = new Map();
  for (const row of rows) {
    const versionKnown = typeof row.game_version === "string" &&
      /\d+\.\d+/.test(row.game_version) && !row.game_version.includes("?");
    const key = JSON.stringify([row.game_version, row.set_number, row.set_core_name,
      row.queue_id, row.game_type, versionKnown ? null : row.match_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return {
    max_history_matches: MAX_HISTORY_MATCHES,
    stored_match_count: rows.length,
    coverage_start: rows.length ? rows[rows.length - 1].datetime : null,
    coverage_end: rows.length ? rows[0].datetime : null,
    limitations: [
      "Final states only; no shop, purchases, rerolls, bench or positioning timeline.",
      "Equipped item entries include components; they are not completed item counts.",
      "Opposing final boards are recorded at different elimination times, not simultaneous scouting.",
      "Trait groups describe final boards, not confirmed strategies or causal effects.",
      "Missing metrics are excluded, not treated as zero. Small samples are descriptive only.",
      "Unverified missions data is archived privately and excluded from all metrics.",
      "History accumulates from processed matches; this is not a complete career archive.",
      "Placement/top4 labels are not team-adjusted; interpret each queue separately."
    ],
    groups: [...groups.values()].map(group => {
      const first = group[0];
      const traits = new Map();
      for (const row of group) {
        const key = row.key_traits.map(t => t.id).sort().join("|") || "unknown";
        if (!traits.has(key)) traits.set(key, []);
        traits.get(key).push(row);
      }
      return {
        game_version: first.game_version,
        patch_comparison_available: typeof first.game_version === "string" &&
          /\d+\.\d+/.test(first.game_version) && !first.game_version.includes("?"),
        set_number: first.set_number,
        set_core_name: first.set_core_name,
        queue_id: first.queue_id,
        game_type: first.game_type,
        summary: summarizeRows(group),
        recent_10: summarizeRows(group.slice(0, 10)),
        previous_10: summarizeRows(group.slice(10, 20)),
        final_trait_groups: [...traits.values()].map(traitRows => ({
          traits: traitRows[0].key_traits,
          ...summarizeRows(traitRows)
        })),
        matches: group
      };
    })
  };
}

async function getHealth(env) {
  const saved = JSON.parse(await env.TFT_KV.get("sync_status") || "null");
  if (!saved) return {schema_version: SCHEMA_VERSION, status: "waiting", last_attempt_at: null};
  const stale = Date.now() - Date.parse(saved.last_attempt_at) > 20 * 60 * 1000;
  return {...saved, stale, status: stale ? "stale" : saved.status};
}

function buildReviewEvidence(match) {
  const me = match.me;
  const opponents = match.lobby.filter(p => !p.is_me);
  const unknown = me.units.filter(u => u.classification === "unknown").map(u => u.id);
  const units = [...new Map(me.units.map(u => [u.id, u])).values()];
  return {
    source: "final_boards_only",
    patch_verified: Boolean(knownPatch(match.game.game_version)),
    unknown_unit_ids: unknown,
    missing_name_ids: me.units.filter(u => u.name_ko === u.id).map(u => u.id),
    signals: {
      gold_review: me.placement >= 5 && me.gold_left >= 20,
      gold_review_is_proof_of_error: false,
      one_star_equipped_units: me.units.filter(u => u.star === 1 && u.items.length > 0).map(u => u.id),
      frontline_count: null,
      frontline_count_reason: "unit_roles_not_verified",
      completed_item_count: null,
      item_count_reason: "item_categories_not_verified"
    },
    contested_units: units.map(u => ({id: u.id, name_ko: u.name_ko,
      opponent_boards: opponents.filter(p => p.units.some(v => v.id === u.id)).map(p => ({
        placement: p.placement, last_round: p.last_round,
        stars: p.units.filter(v => v.id === u.id).map(v => v.star)
      }))})).filter(u => u.opponent_boards.length),
    limitations: ["Opponents finished at different times; this is not simultaneous scouting.",
      "No shop, reroll, purchase, bench or positioning timeline.",
      "Unknown units must not be assumed to be tanks or summons."]
  };
}

function buildSimilarBoards(matches) {
  return matches.map(match => {
    const version = match.game.game_version;
    if (!knownPatch(version)) return {match_id: match.match_id, available: false,
      reason: "unknown_patch", sample_count: 0, examples: []};
    const anchors = match.me.units.filter(u => u.classification === "shop_unit" && u.items.length >= 2);
    const candidates = [];
    for (const other of matches) {
      if (other.match_id === match.match_id) continue;
      if (["game_version", "set_number", "set_core_name", "queue_id", "game_type"]
          .some(k => other.game[k] == null || match.game[k] == null || other.game[k] !== match.game[k])) continue;
      for (const player of other.lobby) {
        if (numericOrNull(player.level) === null || numericOrNull(match.me.level) === null ||
            numericOrNull(player.last_round) === null || numericOrNull(match.me.last_round) === null) continue;
        if (Math.abs(player.level - match.me.level) > 1 || Math.abs(player.last_round - match.me.last_round) > 3) continue;
        const overlap = anchors.filter(a => player.units.some(u => u.id === a.id && u.star === a.star));
        if (!overlap.length) continue;
        candidates.push({match_id: other.match_id, placement: player.placement,
          level: player.level, last_round: player.last_round,
          matched_units: overlap.map(a => a.id), units: player.units});
      }
    }
    return {match_id: match.match_id, available: true, sample_count: candidates.length,
      small_sample: candidates.length < 20,
      method: "same_build_set_queue_mode; level +/-1; last_round +/-3; equipped unit and star match",
      limitation: "Local archive only; not a representative meta sample or proof of better decisions.",
      examples: candidates.sort((a, b) => b.matched_units.length - a.matched_units.length || a.placement - b.placement).slice(0, 5)};
  });
}

function rawJson(text) {
  return new Response(
    text,
    {
      headers: {
        "content-type":
          "application/json; charset=UTF-8",
        "cache-control":
          "no-store"
      }
    }
  );
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8",
        "cache-control":
          "no-store"
      }
    }
  );
}
