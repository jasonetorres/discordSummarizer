require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");

// ─── Config ────────────────────────────────────────────────────────────────
const GUILD_ID            = process.env.GUILD_ID || "";
const ANALYTICS_CRON      = process.env.ANALYTICS_CRON || "*/30 * * * *"; // every 30 min
const MESSAGE_FETCH_LIMIT = parseInt(process.env.MESSAGE_FETCH_LIMIT || "200", 10);

const FB_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
const FB_DB_SECRET    = process.env.FIREBASE_DB_SECRET || "";
const FB_DATA_PATH    = "da-ops-hub-data";

// ─── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Firebase Helpers ──────────────────────────────────────────────────────

async function fbPut(path, data) {
  if (!FB_DATABASE_URL || !FB_DB_SECRET) return;
  try {
    const url = `${FB_DATABASE_URL}/${path}.json?auth=${FB_DB_SECRET}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[Firebase] PUT ${path} failed (${res.status}): ${text}`);
    }
  } catch (err) {
    console.warn("[Firebase] error:", err.message);
  }
}

async function fbPatch(path, data) {
  if (!FB_DATABASE_URL || !FB_DB_SECRET) return;
  try {
    const url = `${FB_DATABASE_URL}/${path}.json?auth=${FB_DB_SECRET}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[Firebase] PATCH ${path} failed (${res.status}): ${text}`);
    }
  } catch (err) {
    console.warn("[Firebase] error:", err.message);
  }
}

// ─── Analytics Collection ──────────────────────────────────────────────────

async function collectAnalytics() {
  if (!GUILD_ID) {
    console.warn("[Analytics] GUILD_ID not set, skipping.");
    return;
  }

  try {
    console.log(`[Analytics] Starting collection at ${new Date().toISOString()}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      console.warn(`[Analytics] Guild ${GUILD_ID} not in cache.`);
      return;
    }

    await guild.fetch();
    await guild.members.fetch();

    const now   = new Date();
    const today = now.toISOString().split("T")[0];

    // ── Guild Info ──────────────────────────────────────────────────────────
    const textChannelCount  = guild.channels.cache.filter((ch) => ch.isTextBased() && !ch.isThread()).size;
    const voiceChannelCount = guild.channels.cache.filter((ch) => ch.type === 2 || ch.type === 13).size;

    const guildInfo = {
      name:              guild.name,
      memberCount:       guild.memberCount,
      boostTier:         guild.premiumTier,
      boostCount:        guild.premiumSubscriptionCount || 0,
      iconURL:           guild.iconURL({ size: 64 }) || null,
      channelCount:      textChannelCount,
      voiceChannelCount: voiceChannelCount,
      roleCount:         Math.max(0, guild.roles.cache.size - 1),
      lastUpdated:       now.toISOString(),
    };

    // ── Role Distribution ───────────────────────────────────────────────────
    const roles = Array.from(guild.roles.cache.values())
      .filter((r) => r.name !== "@everyone" && r.members.size > 0)
      .sort((a, b) => b.members.size - a.members.size)
      .slice(0, 15)
      .map((r) => ({
        id:          r.id,
        name:        r.name,
        memberCount: r.members.size,
        color:       r.hexColor !== "#000000" ? r.hexColor : "#5865F2",
      }));

    // ── Channel Stats + Activity Patterns ──────────────────────────────────
    const DAY_NAMES  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const activityByDay  = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    const activityByHour = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i, 0]));

    const textChannels = guild.channels.cache.filter(
      (ch) => ch.isTextBased() && !ch.isThread() && ch.viewable
    );

    const channelStats       = {};
    let   totalMessages      = 0;
    const uniqueCommunicators = new Set();

    for (const [, channel] of textChannels) {
      try {
        const messages  = await channel.messages.fetch({ limit: MESSAGE_FETCH_LIMIT });
        const humanMsgs = messages.filter((m) => !m.author.bot && m.content.trim());

        humanMsgs.forEach((m) => {
          const day  = DAY_NAMES[m.createdAt.getDay()];
          const hour = m.createdAt.getUTCHours();
          activityByDay[day]   = (activityByDay[day] || 0) + 1;
          activityByHour[hour] = (activityByHour[hour] || 0) + 1;
          uniqueCommunicators.add(m.author.id);
        });

        totalMessages += humanMsgs.size;

        if (humanMsgs.size > 0) {
          channelStats[channel.id] = {
            id:           channel.id,
            name:         channel.name,
            messageCount: humanMsgs.size,
            lastActivity: messages.first()?.createdAt.toISOString() || null,
          };
        }
      } catch (_) {
        // Missing read permissions — skip silently
      }
    }

    const topChannels = Object.values(channelStats)
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 15);

    // ── Engagement Summary ──────────────────────────────────────────────────
    const engagement = {
      totalMessages,
      uniqueCommunicators: uniqueCommunicators.size,
      activeChannels:      Object.keys(channelStats).length,
      avgMessagesPerDay:   Math.round(totalMessages / 30),
      lastUpdated:         now.toISOString(),
    };

    // ── Push to Firebase ────────────────────────────────────────────────────
    const base = `${FB_DATA_PATH}/discordAnalytics`;

    await fbPut(`${base}/guildInfo`,      guildInfo);
    await fbPut(`${base}/roles`,          roles);
    await fbPut(`${base}/topChannels`,    topChannels);
    await fbPut(`${base}/activityByDay`,  activityByDay);
    await fbPut(`${base}/activityByHour`, activityByHour);
    await fbPut(`${base}/engagement`,     engagement);
    await fbPatch(`${base}/memberSnapshots`, { [today]: guild.memberCount });

    console.log(
      `[Analytics] done — ${guild.memberCount} members · ${totalMessages} msgs · ` +
      `${Object.keys(channelStats).length} active channels · ${uniqueCommunicators.size} communicators`
    );
  } catch (err) {
    console.error("[Analytics] Collection failed:", err.message, err);
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅ Discord Analytics Collector — ${client.user.tag}`);
  console.log(`   Guild:    ${GUILD_ID || "(not set)"}`);
  console.log(`   Schedule: ${ANALYTICS_CRON}`);
  console.log(`   Firebase: ${FB_DATABASE_URL || "(not configured)"}`);

  collectAnalytics();
  cron.schedule(ANALYTICS_CRON, collectAnalytics);
});

client.on("error", (err) => console.error("[Discord] error:", err.message));

client.login(process.env.BOT_TOKEN).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
