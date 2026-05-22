require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const Parser = require("rss-parser");
const fs = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID   = process.env.DISCORD_CLIENT_ID;
const CHANNEL_ID  = process.env.DISCORD_CHANNEL_ID;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "300000");
const STATE_FILE  = "./state.json";

const NYAA_MANGA_RSS = "https://nyaa.si/?page=rss&c=3_1";

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Start watching a manga for new chapter uploads on nyaa.si")
    .addStringOption((o) =>
      o.setName("title").setDescription("Manga title to watch (e.g. One Piece)").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("Stop watching a manga")
    .addStringOption((o) =>
      o.setName("title").setDescription("Manga title to stop watching").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Show all manga currently being watched"),
].map((c) => c.toJSON());

// ── State ─────────────────────────────────────────────────────────────────────
// state.json structure:
// {
//   watchlist: { "one piece": "123456789" },   // title → user ID who added it
//   announcedChapters: { "one piece": ["0001"] },
//   seenTorrents: ["guid1", ...]
// }
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      watchlist:         raw.watchlist          || {},  // { title: userId }
      announcedChapters: raw.announcedChapters  || {},
      seenTorrents:      new Set(raw.seenTorrents || []),
    };
  } catch {
    return { watchlist: {}, announcedChapters: {}, seenTorrents: new Set() };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      watchlist:         state.watchlist,
      announcedChapters: state.announcedChapters,
      seenTorrents:      [...state.seenTorrents],
    }, null, 2)
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function titleDisplay(t) {
  return t.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Returns the matched watchlist key, or null
function matchesWatchlist(itemTitle, watchlist) {
  if (!itemTitle) return null;
  const lower = itemTitle.toLowerCase();
  for (const watched of Object.keys(watchlist)) {
    const words = watched.split(/\s+/).filter(Boolean);
    if (words.every((w) => lower.includes(w))) return watched;
  }
  return null;
}

function extractChapterKey(title) {
  if (!title) return null;
  const patterns = [
    /ch(?:apter)?[\s._-]*(\d+(?:\.\d+)?)/i,
    /c(\d{2,4}(?:\.\d+)?)/i,
    /vol(?:ume)?[\s._-]*(\d+)/i,
    /#(\d+)/,
    /(?:\s[-–]\s)(\d{1,4}(?:\.\d+)?)(?:\s|v\d|\(|$)/,
    /\b(\d{3,4}(?:\.\d+)?)\b/,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) {
      const [intPart, decPart] = m[1].split(".");
      return intPart.padStart(4, "0") + (decPart !== undefined ? `.${decPart}` : "");
    }
  }
  return null;
}

function buildEmbed(item, matchedTitle) {
  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle(`📖 New Chapter — ${titleDisplay(matchedTitle)}`)
    .setDescription(`**${item.title}**`)
    .setURL(item.link)
    .setFooter({ text: "nyaa.si • Manga Monitor" })
    .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date())
    .addFields(
      { name: "🔗 Download", value: item.link || "N/A" },
      ...(item.contentSnippet
        ? [{ name: "ℹ️ Info", value: item.contentSnippet.slice(0, 300) }]
        : [])
    );
}

// ── Register slash commands ───────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`[${new Date().toISOString()}] Slash commands registered.`);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
}

// ── Core RSS poll ─────────────────────────────────────────────────────────────
async function checkFeeds(client, state) {
  if (Object.keys(state.watchlist).length === 0) return;

  const parser = new Parser({ timeout: 10000 });
  let dirty = false;

  let feed;
  try {
    feed = await parser.parseURL(NYAA_MANGA_RSS);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] RSS fetch failed:`, err.message);
    return;
  }

  for (const item of feed.items || []) {
    const torrentId = item.guid || item.link;
    if (!torrentId) continue;

    const fresh = !state.seenTorrents.has(torrentId);
    state.seenTorrents.add(torrentId);
    if (fresh) dirty = true;
    if (!fresh) continue;

    const matched = matchesWatchlist(item.title, state.watchlist);
    if (!matched) continue;

    const chapterKey = extractChapterKey(item.title);
    const announced  = state.announcedChapters[matched] || [];

    if (chapterKey && announced.includes(chapterKey)) {
      console.log(`[${new Date().toISOString()}] Skipping duplicate (${matched} ${chapterKey})`);
      continue;
    }

    console.log(`[${new Date().toISOString()}] New chapter: ${item.title}`);

    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) { console.error("Channel not found:", CHANNEL_ID); continue; }

      // Ping only the user who added this manga
      const userId = state.watchlist[matched];
      const ping   = userId ? `<@${userId}>` : "";

      const embed = buildEmbed(item, matched);
      await channel.send({ content: `${ping} New chapter alert! 📖`, embeds: [embed] });

      state.announcedChapters[matched] = [...announced, chapterKey || torrentId];
      dirty = true;

      console.log(`[${new Date().toISOString()}] Announced to <@${userId}>: ${item.title}`);
    } catch (err) {
      console.error("Failed to send message:", err.message);
    }
  }

  if (dirty) saveState(state);
}

// ── Handle slash commands ─────────────────────────────────────────────────────
function setupInteractions(client, state) {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === "watch") {
      const title  = interaction.options.getString("title").trim().toLowerCase();
      const userId = interaction.user.id;

      if (state.watchlist[title]) {
        return interaction.reply({ content: `Already watching **${titleDisplay(title)}**.`, ephemeral: true });
      }

      // Store title → user ID
      state.watchlist[title] = userId;
      saveState(state);
      console.log(`[${new Date().toISOString()}] Now watching: ${title} (added by ${userId})`);
      await interaction.reply(`✅ Now watching **${titleDisplay(title)}** — I'll ping you when a new chapter appears on nyaa.`);
    }

    else if (commandName === "unwatch") {
      const title = interaction.options.getString("title").trim().toLowerCase();

      if (!state.watchlist[title]) {
        return interaction.reply({ content: `I'm not watching **${titleDisplay(title)}**.`, ephemeral: true });
      }

      delete state.watchlist[title];
      delete state.announcedChapters[title];
      saveState(state);
      console.log(`[${new Date().toISOString()}] Stopped watching: ${title}`);
      await interaction.reply(`🗑️ Stopped watching **${titleDisplay(title)}**.`);
    }

    else if (commandName === "watchlist") {
      const entries = Object.entries(state.watchlist);
      if (entries.length === 0) {
        return interaction.reply({ content: "Nothing on the watchlist yet. Use `/watch` to add something.", ephemeral: true });
      }

      const list = entries
        .map(([t, userId], i) => {
          const chCount = (state.announcedChapters[t] || []).length;
          return `${i + 1}. **${titleDisplay(t)}** — ${chCount} chapter${chCount !== 1 ? "s" : ""} announced • added by <@${userId}>`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle("📋 Manga Watchlist")
        .setDescription(list)
        .setFooter({ text: `${entries.length} title${entries.length !== 1 ? "s" : ""} being monitored` });

      await interaction.reply({ embeds: [embed] });
    }
  });
}

// ── Bot startup ───────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN)      throw new Error("Missing DISCORD_TOKEN");
  if (!CLIENT_ID)  throw new Error("Missing DISCORD_CLIENT_ID");
  if (!CHANNEL_ID) throw new Error("Missing DISCORD_CHANNEL_ID");

  await registerCommands();

  const state = loadState();
  console.log(
    `[${new Date().toISOString()}] Watching ${Object.keys(state.watchlist).length} title(s). ` +
    `${state.seenTorrents.size} torrents seen.`
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  setupInteractions(client, state);

  client.once("ready", () => {
    console.log(`[${new Date().toISOString()}] Logged in as ${client.user.tag}`);
    console.log(`[${new Date().toISOString()}] Polling nyaa.si every ${CHECK_INTERVAL_MS / 1000}s`);
    checkFeeds(client, state);
    setInterval(() => checkFeeds(client, state), CHECK_INTERVAL_MS);
  });

  client.on("error", (err) => console.error("Discord client error:", err));
  await client.login(TOKEN);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
