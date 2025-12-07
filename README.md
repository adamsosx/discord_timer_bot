## Discord Timer Bot

![Screenshot](images/bot-screenshot.png)

Discord bot that provides channel timers with live updates, quick buttons, voice notifications, microphone history, and cleanup utilities.

### Features
- Text and slash commands (`!cs`, `!status`, `!stop`, `/timer`, `/set-default`, `/help`).
- Quick-action buttons for starting/pausing/stopping timers and common durations.
- Voice notifications (warning + end sounds) when the bot is connected to a voice channel.
- Microphone history (last 10 users who unmuted), with mute/unmute controls.
- Channel cleanup (bot messages and command messages) with confirmation.
- Auto-cleanup routines to prevent leaks (timers, intervals, histories).

### Requirements
- Node.js 22 LTS recommended (`@discordjs/voice@0.19.0` requires >= 22.12). Works on 20, but upgrade to avoid voice issues.
- npm 10+ (bundled with Node).

### Setup
1) Install dependencies:
```
npm install
```

2) Create `.env` in the project root:
```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
# optional:
GUILD_ID=your_guild_id            # for guild-only command registration fallback
DEFAULT_TIMER_DURATION=300000     # ms, default 5m
ENABLE_VOICE_NOTIFICATIONS=true
ENABLE_MICROPHONE_HISTORY=true
ENABLE_AUTO_CLEANUP=true
DEBUG_MODE=false
VERBOSE_LOGGING=false
```

3) Ensure sound files exist (already provided):
- `sounds/cri.mp3` (warning)
- `sounds/end.mp3` (final)

### Running
- Start: `npm start`
- Dev (nodemon): `npm run dev`

On startup, config validation runs and slash commands attempt global registration (with guild fallback).

### Commands (text)
- `!cs [time]` start/reset timer (e.g., `5m`, `30s`, `1h`; no arg = default).
- `!stop` stop timer (reports remaining time).
- `!status` show timer status.
- `!set cs [time]` set default timer for guild.
- `!start` show help.
- `!join` / `!connect` connect bot to your voice channel.
- `!leave` / `!disconnect` disconnect bot from voice.
- `!test1` / `!test2` play warning/final sound (tries to join your voice).
- `!miclog` show microphone unmute history; `!clearvoicehistory` clear it.
- `!cleanup` clean voice connections.

### Slash commands
- `/timer [duration]`
- `/set-default <duration>`
- `/help`
- `/voice-connect`
- `/voice-disconnect`
- `/sound-test typ: warning|end`
- `/mic-history`
- `/clear-mic-history`
- `/clear-channel`

### Buttons (high level)
- Start/Pause/Stop timer, connect/disconnect voice, microphone history, clear history, clear channel, quick durations (2m/4m/5m/6m/40m), manual time info, help.

### Notes
- Rate limits: per-user and global safeguards are applied.
- Cleanup: periodic cleanup for timers, intervals, histories, and orphaned messages.
- Voice: ensure the bot has voice permissions; sounds play only when the bot is in a voice channel.
- Discord permissions & intents: enable Guilds, GuildMessages, MessageContent, GuildVoiceStates, GuildMembers in the Discord developer portal; grant server perms for voice connect/speak and message delete (for cleanup).

### Smoke test (recommended)
1) Run on Node 22: `nvm use 22` (or install: `nvm install 22 && nvm use 22`), then `npm install` (to rebuild native deps) and `npm start`.
2) In Discord:
   - Slash: `/timer 2m`, `/sound-test typ: warning`, `/sound-test typ: end`, `/help`.
   - Buttons: Start timer, Pause/Stop, Connect/Disconnect voice (bot must be in a voice channel for sounds), Quick timers.
3) Verify warning and end sounds play in voice; check timer updates and cleanup buttons.

### Author
- amadosx🍒


