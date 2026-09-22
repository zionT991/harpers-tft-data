const GAME_NAME = "Harpers";
const TAG_LINE = "KR1";
const REGION = "asia";

const MAX_STORED_MATCHES = 20;
const MATCH_LOOKBACK = 20;
const SCHEMA_VERSION = 6;

const GITHUB_BRANCH = "main";
const GITHUB_FILE_PATH = "recent.json";

const CDRAGON_BASE =
  "https://raw.communitydragon.org/latest/" +
  "plugins/rcp-be-lol-game-data/global/ko_kr/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        service: "Harpers TFT Tracker",
        status: "ok",
        player: `${GAME_NAME}#${TAG_LINE}`,
        schema_version: SCHEMA_VERSION,
        endpoints: ["/health", "/latest", "/recent", "/recent?limit=5"]
      });
    }

    if (url.pathname === "/health") {
      return json({
        status: "ok",
        player: `${GAME_NAME}#${TAG_LINE}`,
        schema_version: SCHEMA_VERSION
      });
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

      return rawJson(latest);
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
        matches
      });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncMatches(env));
  }
};

async function syncMatches(env) {
  try {
    validateGithubConfig(env);

    const puuid = await getPuuid(env);
    const dictionary = await getKoreanDictionary(env);

    const idsUrl =
      `https://${REGION}.api.riotgames.com` +
      `/tft/match/v1/matches/by-puuid/` +
      `${encodeURIComponent(puuid)}/ids` +
      `?start=0&count=${MATCH_LOOKBACK}`;

    const matchIds = await riotFetch(idsUrl, env);

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      console.log("최근 TFT 경기 없음");
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

    if (matchesToProcess.length > 0) {
      console.log(`재수집/신규 경기 ${matchesToProcess.length}개`);

      matchesToProcess.reverse();

      for (const matchId of matchesToProcess) {
        const matchUrl =
          `https://${REGION}.api.riotgames.com` +
          `/tft/match/v1/matches/` +
          `${encodeURIComponent(matchId)}`;

        const match = await riotFetch(matchUrl, env);

        const result = buildMatchResult(
          match,
          matchId,
          puuid,
          dictionary
        );

        await env.TFT_KV.put(
          `match:${matchId}`,
          JSON.stringify(result)
        );

        recentIds = [
          matchId,
          ...recentIds.filter(id => id !== matchId)
        ].slice(0, MAX_STORED_MATCHES);

        if (matchId === matchIds[0]) {
          newestResult = result;
        }

        console.log(
          `저장 완료 ${matchId} / ${result.me?.placement ?? "?"}위`
        );
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

    await maybePublishGithubMirror(env, matchIds[0]);

    console.log(`동기화 완료 ${matchIds[0]}`);
  } catch (error) {
    console.error(
      `TFT sync error message: ${error?.message ?? String(error)}`
    );

    console.error(
      `TFT sync error stack: ${error?.stack ?? "no stack"}`
    );
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
      participant.gold_left ?? 0,

    players_eliminated:
      participant.players_eliminated ?? 0,

    total_damage_to_players:
      participant.total_damage_to_players ?? 0,

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
            trait.num_units ?? 0,

          tier_current:
            trait.tier_current ?? 0,

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
            unit.tier ?? 0,

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

async function getKoreanDictionary(env) {
  const cacheKey =
    `ko_dictionary_v${SCHEMA_VERSION}_r1`;

  const cached = await env.TFT_KV.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {}
  }

  console.log("한국어 사전 생성 시작");

  const [
    championsJson,
    traitsJson,
    itemsJson,
    contentJson
  ] = await Promise.all([
    fetchJson(`${CDRAGON_BASE}/tftchampions.json`),
    fetchJson(`${CDRAGON_BASE}/tfttraits.json`),
    fetchJson(`${CDRAGON_BASE}/tftitems.json`),
    fetchJson(`${CDRAGON_BASE}/tftcontentdata.json`)
  ]);

  const champions =
    mergeMaps(
      buildNameMap(championsJson),
      buildNameMap(contentJson)
    );

  const traits =
    mergeMaps(
      buildNameMap(traitsJson),
      buildNameMap(contentJson)
    );

  const items =
    mergeMaps(
      buildNameMap(itemsJson),
      buildNameMap(contentJson)
    );

  const augments =
    mergeMaps(
      buildNameMap(contentJson),
      buildNameMap(itemsJson)
    );

  const dictionary = {
    source:
      "CommunityDragon ko_kr",

    created_at:
      new Date().toISOString(),

    champions,
    traits,
    items,
    augments
  };

  await env.TFT_KV.put(
    cacheKey,
    JSON.stringify(dictionary),
    {
      expirationTtl:
        60 * 60 * 24
    }
  );

  return dictionary;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Harpers-TFT-Tracker"
    }
  });

  if (!response.ok) {
    throw new Error(
      `CommunityDragon HTTP ${response.status}`
    );
  }

  return response.json();
}

function normalizeGameId(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  let s = String(value)
    .trim()
    .toLowerCase();

  s = s.replace(/^da[_-]?/, "");
  s = s.replace(/^tft[_-]?/, "");
  s = s.replace(/\d+/g, "");

  s = s.replace(
    /^[_-]*(item|trait|champion|unit)[_-]*/,
    ""
  );

  s = s.replace(
    /[^a-z0-9가-힣]/g,
    ""
  );

  return s;
}

function buildNameMap(data) {
  const map = {};

  walkObject(
    data,
    obj => {
      if (
        !obj ||
        typeof obj !== "object" ||
        Array.isArray(obj)
      ) {
        return;
      }

      const displayName =
        firstNonEmptyString([
          obj.name,
          obj.displayName,
          obj.title
        ]);

      if (!displayName) {
        return;
      }

      const identifiers = [
        obj.apiName,
        obj.characterName,
        obj.id,
        obj.nameId,
        obj.internalName,
        obj.key
      ];

      for (
        const identifier
        of identifiers
      ) {
        if (
          identifier === undefined ||
          identifier === null
        ) {
          continue;
        }

        const id =
          String(identifier).trim();

        if (!id) continue;

        map[id] = displayName;
        map[id.toLowerCase()] = displayName;

        const normalized =
          normalizeGameId(id);

        if (normalized) {
          const key =
            `__normalized__${normalized}`;

          if (!map[key]) {
            map[key] = displayName;
          }
        }
      }
    }
  );

  return map;
}

function translateName(dictionary, id) {
  if (
    id === undefined ||
    id === null
  ) {
    return "";
  }

  const key =
    String(id).trim();

  if (!key) return "";

  if (dictionary?.[key]) {
    return dictionary[key];
  }

  const lower = key.toLowerCase();

  if (dictionary?.[lower]) {
    return dictionary[lower];
  }

  // Riot DA IDs use a set prefix that is not always present in
  // CommunityDragon identifiers (for example DA_18_Hecarim).
  const daMatch =
    key.match(/^DA[_-]?\d+[_-](.+)$/i);

  if (daMatch) {
    const shortId = daMatch[1];
    const shortLower = shortId.toLowerCase();

    if (dictionary?.[shortId]) {
      return dictionary[shortId];
    }

    if (dictionary?.[shortLower]) {
      return dictionary[shortLower];
    }

    const normalizedShort =
      normalizeGameId(shortId);

    const normalizedShortKey =
      `__normalized__${normalizedShort}`;

    if (
      normalizedShort &&
      dictionary?.[normalizedShortKey]
    ) {
      return dictionary[normalizedShortKey];
    }
  }

  const normalized =
    normalizeGameId(key);

  const normalizedKey =
    `__normalized__${normalized}`;

  if (
    normalized &&
    dictionary?.[normalizedKey]
  ) {
    return dictionary[normalizedKey];
  }

  return key;
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
    headers: {
      "X-Riot-Token":
        env.RIOT_API_KEY
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Riot API ${response.status} | ${text}`
    );
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
  const marker =
    `${SCHEMA_VERSION}:${latestMatchId}`;

  const oldMarker =
    await env.TFT_KV.get("github_mirror_marker");

  if (oldMarker === marker) {
    console.log("GitHub mirror 변경 없음");
    return;
  }

  const matches =
    await getRecentMatches(
      env,
      MAX_STORED_MATCHES
    );

  const publicMatches =
    matches.map(
      sanitizeMatchForPublic
    );

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

  if (includeDebug) {
    output.debug_augment =
      player.debug_augment ?? null;
  }

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
      `GitHub GET ${getResponse.status} ` +
      await getResponse.text()
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
        headers: githubHeaders(env),
        body: JSON.stringify(body)
      }
    );

  if (!putResponse.ok) {
    throw new Error(
      `GitHub PUT ${putResponse.status} ` +
      await putResponse.text()
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
