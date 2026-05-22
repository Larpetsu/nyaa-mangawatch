<div align="center">


# Manga Nyaa Monitor

**Watches nyaa.si and pings you on Discord the second a new chapter drops.**

</div>

---

You tell it what series to look out for, it tells you when there is a new chapter. The bot pings you when a new chapter for the series you want is uploaded.
---

## Commands

| Command | What it does |
|---|---|
| `/watch {series}` | Add a manga to the watchlist |
| `/unwatch {series}` | Remove it |
| `/watchlist` | See everything you're tracking |

---

## Setup

```bash
git clone https://github.com/yourusername/manga-nyaa-bot.git
cd manga-nyaa-bot
npm install
cp .env.example .env   # fill in your token, client ID, and channel ID
npm start
```

Three values go in your `.env`:

```env
DISCORD_TOKEN=        # bot token from the Developer Portal
DISCORD_CLIENT_ID=    # your app's client ID, also in the Portal
DISCORD_CHANNEL_ID=   # right-click a channel in Discord → Copy Channel ID
```

When inviting the bot, make sure your OAuth2 URL includes both the `bot` and `applications.commands` scopes, otherwise slash commands won't show up.

---

## Docker

```bash
docker build -t manga-nyaa-bot .
docker run -d --restart unless-stopped --env-file .env \
  -v $(pwd)/state.json:/app/state.json manga-nyaa-bot
```

Mount `state.json` or it'll forget your watchlist every restart.

---

<div align="center">



</div>
