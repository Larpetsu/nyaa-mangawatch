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

// Nyaa.si manga category RSS (c=3_1 = Literature - English-translated)
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
//   watchlist: ["one piece", "bleach", ...],          // normalised lowercase titles
//   announcedChapters: { "one piece": ["001","002"] }, // first-upload-only tracking
//   seenTorrents: ["guid1", "guid2", ...]              // avoid re-processing known items
// }
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      watchlist:          new Set(raw.watchlist         || []),
      announcedChapters:  raw.announcedChapters         || {},
      seenTorrents:       new Set(raw.seenTorrents      || []),
    };
  } catch {
    return { watchlist: new Set(), announcedChapters: {}, seenTorrents: new Set() };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      watchlist:         [...state.watchlist],
      announcedChapters: state.announcedChapters,
      seenTorrents:      [...state.seenTorrents],
    }, null, 2)
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the watched title that this nyaa item matches, or null.
function matchesWatchlist(itemTitle, watchlist) {
  if (!itemTitle) return null;
  const lower = itemTitle.toLowerCase();
  for (const watched of watchlist) {
    // All words in the watched title must appear in the item title
    const words = watched.split(/\s+/).filter(Boolean);
    if (words.every((w) => lower.includes(w))) return watched;
  }
  return null;
}

// Extract a chapter/volume number from the title.
// Handles: Ch.001, Chapter 12, Vol.3, c001, #12, " - 05 ", plain trailing numbers.
function extractChapterKey(title) {
  if (!title) return null;

  const patterns = [
    /ch(?:apter)?[\s._-]*(\d+(?:\.\d+)?)/i,
    /c(\d{2,4}(?:\.\d+)?)/i,
    /vol(?:ume)?[\s._-]*(\d+)/i,
    /#(\d+)/,
    /(?:\s[-–]\s)(\d{1,4}(?:\.\d+)?)(?:\s|v\d|\(|$)/,
    /\b(\d{3,4}(?:\.\d+)?)\b/,       // bare 3-4 digit numbers (common for chapter nums)
  ];

  for (const re of patterns) {
    const m = title.match(re);
    if (m) {
      // Pad integer part to 4 digits for reliable sorting/comparison
      const [intPart, decPart] = m[1].split(".");
      const padded = intPart.padStart(4, "0") + (decPart !== undefined ? `.${decPart}` : "");
      return padded;
    }
  }
  return null;
}

function buildEmbed(item, matchedTitle) {
  const display = matchedTitle
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle(`📖 New Chapter — ${display}`)
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
  if (state.watchlist.size === 0) return;

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

    // Deduplicate by chapter number
    const chapterKey = extractChapterKey(item.title);
    const announced  = state.announcedChapters[matched] || [];

    if (chapterKey && announced.includes(chapterKey)) {
      console.log(`[${new Date().toISOString()}] Skipping duplicate chapter (${matched} ${chapterKey}): ${item.title}`);
      continue;
    }

    console.log(`[${new Date().toISOString()}] New chapter: ${item.title}`);

    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) { console.error("Channel not found:", CHANNEL_ID); continue; }

      const embed = buildEmbed(item, matched);
      await channel.send({
        content: `@everyone New chapter alert! 📖`,
        embeds: [embed],
      });

      if (chapterKey) {
        state.announcedChapters[matched] = [...announced, chapterKey];
      } else {
        // No chapter number found — still record torrent so we don't re-announce
        state.announcedChapters[matched] = [...announced, torrentId];
      }
      dirty = true;

      console.log(`[${new Date().toISOString()}] Announced: ${item.title}`);
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
      const title = interaction.options.getString("title").trim().toLowerCase();
      if (state.watchlist.has(title)) {
        return interaction.reply({ content: `Already watching **${title}**.`, ephemeral: true });
      }
      state.watchlist.add(title);
      saveState(state);
      console.log(`[${new Date().toISOString()}] Now watching: ${title}`);
      await interaction.reply(`✅ Now watching **${title.split(" ").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ")}** — I'll ping when a new chapter appears on nyaa.`);
    }

    else if (commandName === "unwatch") {
      const title = interaction.options.getString("title").trim().toLowerCase();
      if (!state.watchlist.has(title)) {
        return interaction.reply({ content: `I'm not watching **${title}**.`, ephemeral: true });
      }
      state.watchlist.delete(title);
      delete state.announcedChapters[title];
      saveState(state);
      console.log(`[${new Date().toISOString()}] Stopped watching: ${title}`);
      await interaction.reply(`🗑️ Stopped watching **${title.split(" ").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ")}**.`);
    }

    else if (commandName === "watchlist") {
      if (state.watchlist.size === 0) {
        return interaction.reply({ content: "Nothing on the watchlist yet. Use `/watch` to add something.", ephemeral: true });
      }
      const list = [...state.watchlist]
        .map((t, i) => {
          const display = t.split(" ").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
          const chCount = (state.announcedChapters[t] || []).length;
          return `${i + 1}. **${display}** — ${chCount} chapter${chCount !== 1 ? "s" : ""} announced`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle("📋 Manga Watchlist")
        .setDescription(list)
        .setFooter({ text: `${state.watchlist.size} title${state.watchlist.size !== 1 ? "s" : ""} being monitored` });

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
    `[${new Date().toISOString()}] Watching ${state.watchlist.size} title(s). ` +
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
