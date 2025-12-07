const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Validate configuration early to fail fast on missing/invalid env vars
if (config.ConfigValidator && typeof config.ConfigValidator.validate === 'function') {
    config.ConfigValidator.validate();
}

// Simple logging system
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const today = new Date().toISOString().split('T')[0];
const logFile = path.join(logDir, `combined-${today}.log`);
const errorLogFile = path.join(logDir, `error-${today}.log`);

function logToFile(level, message) {
    try {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}]: ${message}\n`;
        fs.appendFileSync(logFile, logEntry);
        
        if (level === 'ERROR') {
            fs.appendFileSync(errorLogFile, logEntry);
        }
    } catch (error) {
        // Silent fail to avoid infinite loops
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Store active timers per channel
const activeTimers = new Map();

// Timer limits to prevent memory exhaustion
const MAX_TIMERS_PER_GUILD = 10;
const MAX_TOTAL_TIMERS = 100;

// Function to check if timer can be created
function canCreateTimer(guildId) {
    if (activeTimers.size >= MAX_TOTAL_TIMERS) {
        console.warn(`Maximum total timers reached: ${MAX_TOTAL_TIMERS}`);
        return false;
    }
    
    let guildTimerCount = 0;
    for (const [channelId, timer] of activeTimers) {
        if (timer.guildId === guildId) guildTimerCount++;
    }
    
    if (guildTimerCount >= MAX_TIMERS_PER_GUILD) {
        console.warn(`Maximum timers per guild reached: ${MAX_TIMERS_PER_GUILD}`);
        return false;
    }
    
    return true;
}

// Store default timer times per guild
const defaultTimes = new Map();

// Store voice connections
const voiceConnections = new Map();

// Store timer messages for updates
const timerMessages = new Map();

// Map to store message flags for cleanup (guildId -> channelId -> messageId)
const messageFlagsForCleanup = new Map();

// Function to set message flag for cleanup
function setMessageFlag(guildId, channelId, messageId) {
    if (!messageFlagsForCleanup.has(guildId)) {
        messageFlagsForCleanup.set(guildId, new Map());
    }
    messageFlagsForCleanup.get(guildId).set(channelId, messageId);
    console.log(`Set message flag for guild ${guildId}, channel ${channelId}, message ${messageId}`);
}

// Function to get message flag for cleanup
function getMessageFlag(guildId, channelId) {
    if (!messageFlagsForCleanup.has(guildId)) return null;
    return messageFlagsForCleanup.get(guildId).get(channelId) || null;
}

// Function to clear message flag
function clearMessageFlag(guildId, channelId) {
    if (!messageFlagsForCleanup.has(guildId)) return;
    messageFlagsForCleanup.get(guildId).delete(channelId);
    if (messageFlagsForCleanup.get(guildId).size === 0) {
        messageFlagsForCleanup.delete(guildId);
    }
}

// Function to cleanup messages from flag onwards
async function cleanupMessagesFromFlag(channel, guildId, channelId) {
    try {
        const flagMessageId = getMessageFlag(guildId, channelId);
        if (!flagMessageId) {
            console.log('No message flag found for cleanup');
            return;
        }

        console.log(`Cleaning up messages from flag ${flagMessageId} onwards`);
        
        // Fetch recent messages
        const messages = await channel.messages.fetch({ limit: 50 });
        const messagesToDelete = [];
        let foundFlag = false;

        // Sort messages by creation time (oldest first)
        const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const message of sortedMessages.values()) {
            // Start collecting messages once we find the flag
            if (message.id === flagMessageId) {
                foundFlag = true;
                continue; // Don't delete the flag message itself (timer message)
            }

            // If we found the flag, collect all newer messages for deletion
            if (foundFlag) {
                // Only delete bot messages
                if (message.author.id === message.client.user.id) {
                    messagesToDelete.push(message);
                }
            }
        }

        console.log(`Found ${messagesToDelete.length} messages to delete from flag onwards`);

        // Delete messages in batches
        if (messagesToDelete.length > 0) {
            // Separate messages older than 14 days (can't bulk delete)
            const now = Date.now();
            const twoWeeksAgo = now - (14 * 24 * 60 * 60 * 1000);
            
            const recentMessages = messagesToDelete.filter(msg => msg.createdTimestamp > twoWeeksAgo);
            const oldMessages = messagesToDelete.filter(msg => msg.createdTimestamp <= twoWeeksAgo);

            // Bulk delete recent messages
            if (recentMessages.length > 1) {
                await channel.bulkDelete(recentMessages);
                console.log(`Bulk deleted ${recentMessages.length} recent messages`);
            } else if (recentMessages.length === 1) {
                await recentMessages[0].delete();
                console.log('Deleted 1 recent message');
            }

            // Delete old messages individually
            for (const message of oldMessages) {
                try {
                    await message.delete();
                    console.log('Deleted 1 old message');
                } catch (error) {
                    console.error('Error deleting old message:', error);
                }
            }
        }

    } catch (error) {
        console.error('Error during message cleanup from flag:', error);
    }
}

// Store volume levels per guild (0.0 = silent, 1.0 = max) - removed

// Store last 10 people who unmuted microphone per guild
const microphoneUnmuteHistory = new Map();

// Rate limiting - 1 command per second per user
const userCooldowns = new Map();
const RATE_LIMIT_MS = 1000; // 1 second

// Global rate limiting
const globalRateLimit = {
    requests: 0,
    resetTime: Date.now() + 60000,
    maxRequests: 100
};

function checkGlobalRateLimit() {
    const now = Date.now();
    if (now > globalRateLimit.resetTime) {
        globalRateLimit.requests = 0;
        globalRateLimit.resetTime = now + 60000;
    }
    return globalRateLimit.requests++ < globalRateLimit.maxRequests;
}

// Command execution tracker to prevent infinite loops
const commandExecutionTracker = new Map();

// Function to check if command is looping
function isCommandLooping(userId, commandName) {
    const key = `${userId}-${commandName}`;
    const executions = commandExecutionTracker.get(key) || [];
    const now = Date.now();
    
    // Remove old entries (older than 5 seconds)
    const recentExecutions = executions.filter(time => now - time < 5000);
    
    if (recentExecutions.length >= 3) {
        return true; // Too many calls in short time
    }
    
    recentExecutions.push(now);
    commandExecutionTracker.set(key, recentExecutions);
    return false;
}

// Cleanup intervals for memory leak prevention
const cleanupIntervals = [];

// Function to clean up all intervals and prevent memory leaks
function cleanupAllIntervals() {
    console.log(`Cleaning up ${cleanupIntervals.length} intervals...`);
    cleanupIntervals.forEach(intervalId => {
        clearInterval(intervalId);
    });
    cleanupIntervals.length = 0;
}

// Function to safely clean up a single timer
function safeCleanupTimer(timer) {
    try {
        if (timer.timeoutId) clearTimeout(timer.timeoutId);
        if (timer.warningTimeoutId) clearTimeout(timer.warningTimeoutId);
        if (timer.updateIntervalId) clearInterval(timer.updateIntervalId);
        if (timer.channelId) timerUpdateThrottle.delete(timer.channelId);
    } catch (error) {
        console.error('Error cleaning up timer:', error);
    }
}

// Function to clean up all active timers
function cleanupAllTimers() {
    console.log(`Cleaning up ${activeTimers.size} active timers...`);
    for (const [channelId, timer] of activeTimers) {
        safeCleanupTimer(timer);
    }
    activeTimers.clear();
}

// Function to check rate limit
function isRateLimited(userId) {
    const now = Date.now();
    const lastCommand = userCooldowns.get(userId);
    
    if (!lastCommand) {
        userCooldowns.set(userId, now);
        return false;
    }
    
    if (now - lastCommand < RATE_LIMIT_MS) {
        return true;
    }
    
    userCooldowns.set(userId, now);
    return false;
}

// Function to add user to microphone unmute history
function addToMicrophoneHistory(guildId, userId, username) {
    if (!microphoneUnmuteHistory.has(guildId)) {
        microphoneUnmuteHistory.set(guildId, []);
    }
    
    const history = microphoneUnmuteHistory.get(guildId);
    
    // Remove user if already in history (to avoid duplicates)
    const existingIndex = history.findIndex(entry => entry.userId === userId);
    if (existingIndex !== -1) {
        history.splice(existingIndex, 1);
    }
    
    // Add user to beginning of array
    history.unshift({
        userId: userId,
        username: username,
        timestamp: new Date()
    });
    
    // Keep only last 10 entries
    if (history.length > 10) {
        history.splice(10);
    }
    
    microphoneUnmuteHistory.set(guildId, history);
}

// Function to get microphone unmute history
function getMicrophoneHistory(guildId) {
    return microphoneUnmuteHistory.get(guildId) || [];
}

// Function to clear microphone unmute history
function clearMicrophoneHistory(guildId) {
    microphoneUnmuteHistory.delete(guildId);
}

// Function to stop all timers in a specific channel
function stopAllTimersInChannel(channelId) {
    let timersStopped = 0;
    
    // Check if there's a timer for this channel
    if (activeTimers.has(channelId)) {
        const timer = activeTimers.get(channelId);
        
        // Clear the interval if it exists
        if (timer.updateIntervalId) {
            clearInterval(timer.updateIntervalId);
        }
        
        // Clear the timeout if it exists
        if (timer.timeoutId) {
            clearTimeout(timer.timeoutId);
        }
        
        // Remove from active timers
        activeTimers.delete(channelId);
        timersStopped = 1;
    }
    
    return timersStopped;
}

// Function to create timer control buttons
function createTimerButtons(hasPermissions = true, interaction = null) {
    // If no permissions passed, assume user has permissions (for backward compatibility)
    // This will be overridden by specific permission checks in button handlers
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('timer_start')
                .setLabel('▶️ Start Timer')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('timer_pause')
                .setLabel('⏸️ Pause')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('timer_stop')
                .setLabel('⏹️ Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('voice_join')
                .setLabel('🔗 Connect to voice channel')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('voice_leave')
                .setLabel('🔌 Disconnect from voice channel')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!hasPermissions)
        );
    
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('voice_history')
                .setLabel('🎤 Microphone History')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('clear_voice_history')
                .setLabel('🗑️ Clear History')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('clear_messages')
                .setLabel('🧹 Clear Channel')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('timer_help')
                .setLabel('🚀 Help')
                .setStyle(ButtonStyle.Primary)
        );
    
    return [row1, row2];
}


// Function to create quick timer buttons
function createQuickTimerButtons(includeBackButton = false, hasPermissions = true, interaction = null) {
    // If no permissions passed, assume user has permissions (for backward compatibility)
    // This will be overridden by specific permission checks in button handlers
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('quick_2m')
                .setLabel('2m')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('quick_4m')
                .setLabel('4m')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('quick_5m')
                .setLabel('5m')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('quick_6m')
                .setLabel('6m')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions),
            new ButtonBuilder()
                .setCustomId('quick_40m')
                .setLabel('40m')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!hasPermissions)
        );
    
    if (includeBackButton) {
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('quick_manual')
                        .setLabel('Manual')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!hasPermissions),
                new ButtonBuilder()
                    .setCustomId('back_to_main')
                        .setLabel('⬅️ Back')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(!hasPermissions)
            );
        return [row1, row2];
    }
    
    return [row1];
}

// Function to create microphone history buttons with mute option
function createMicrophoneHistoryButtons(hasHistory = true) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('voice_history')
                .setLabel('🎤 Microphone History')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mute_user')
                .setLabel('🔇 Mute Microphone')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!hasHistory),
            new ButtonBuilder()
                .setCustomId('unmute_user')
                .setLabel('🔊 Unmute')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!hasHistory),
            new ButtonBuilder()
                .setCustomId('clear_voice_history')
                .setLabel('🗑️ Clear History')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('⬅️ Back')
                .setStyle(ButtonStyle.Primary)
        );
    
    return [row1];
}

// Function to check if user has moderator permissions
function hasModeratorPermissions(member) {
    return member.permissions.has('ModerateMembers') ||
           member.permissions.has('Administrator') ||
           member.roles.cache.some(role => role.permissions.has('ModerateMembers'));
}

// Function to check if user has Timer Bot User role or is admin/moderator
function hasTimerBotUserRole(member) {
    try {
        // Check if user has admin or moderator permissions
        const hasAdmin = member.permissions.has('Administrator');
        const hasManageGuild = member.permissions.has('ManageGuild');
        const hasManageChannels = member.permissions.has('ManageChannels');
        const hasModerateMembers = member.permissions.has('ModerateMembers');
        const hasTimerBotRole = member.roles.cache.some(role => role.name === 'Timer Bot User');
        
        const result = hasAdmin || hasManageGuild || hasManageChannels || hasModerateMembers || hasTimerBotRole;
        
        console.log(`User ${member.user.username} permissions:`, {
            Administrator: hasAdmin,
            ManageGuild: hasManageGuild,
            ManageChannels: hasManageChannels,
            ModerateMembers: hasModerateMembers,
            TimerBotRole: hasTimerBotRole,
            RESULT: result
        });
        
        return result;
    } catch (error) {
        console.error('Error checking permissions:', error);
        // If there's an error, allow access (fallback)
        return true;
    }
}

// Timer update throttling to prevent API spam
const timerUpdateThrottle = new Map(); // channelId -> lastUpdateTime

// Function to update timer message
async function updateTimerMessage(channelId, timer) {
    const guildId = timer.guildId;
    if (!timerMessages.has(guildId)) return;
    
    const guildMessages = timerMessages.get(guildId);
    const messageData = guildMessages.get(channelId);
    if (!messageData || !messageData.message) return;
    
    // Throttle updates to prevent API spam (max once per second)
    const now = Date.now();
    const lastUpdate = timerUpdateThrottle.get(channelId) || 0;
    if (now - lastUpdate < 500) return; // 500ms throttle - more responsive
    timerUpdateThrottle.set(channelId, now);
    
    // Calculate remaining time based on pause state
    let remaining;
    if (timer.isPaused && timer.pausedRemainingTime) {
        remaining = timer.pausedRemainingTime;
    } else {
        remaining = timer.endTime - Date.now();
    }
    
    if (remaining <= 0) {
        timerUpdateThrottle.delete(channelId);
        return;
    }
    
    // Don't update if timer is paused
    if (timer.isPaused) return;
    
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('⏰ Timer Active')
        .setDescription(`**${timer.message}**\n\nDuration: ${formatTime(timer.duration)}\nRemaining: ${formatTime(remaining)}`)
        .setTimestamp();
    
    try {
        await messageData.message.edit({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
    } catch (error) {
        // Only log if it's not a "Unknown Message" error (message was deleted)
        if (error.code !== 10008) {
            console.error('Error updating timer message:', error);
        }
        // Remove from tracking if message was deleted
        if (timerMessages.has(guildId)) {
            timerMessages.get(guildId).delete(channelId);
            if (timerMessages.get(guildId).size === 0) {
                timerMessages.delete(guildId);
            }
        }
        // Clean up throttle entry
        timerUpdateThrottle.delete(channelId);
    }
}

// Helper function to parse time input
function parseTime(timeStr, guildId) {
    if (!timeStr) {
        // Use default time for guild if set, otherwise 5 minutes
        return defaultTimes.get(guildId) || 5 * 60 * 1000;
    }
    
    const match = timeStr.match(/^(\d+)([smh])$/i);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        default: return null;
    }
}

// Helper function to format time
function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// Function to join voice channel
async function joinVoiceChannelBot(guild, voiceChannel) {
    let connection = null;
    try {
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });

        // Add timeout wrapper with Promise.race
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Voice connection timeout')), 30000)
        );

        await Promise.race([
            entersState(connection, VoiceConnectionStatus.Ready, 30e3),
            timeoutPromise
        ]);
        
        voiceConnections.set(guild.id, connection);
        return connection;
    } catch (error) {
        console.error('Error joining voice channel:', error);
        // Important: destroy connection if it exists
        if (connection) connection.destroy();
        return null;
    }
}

// Function to leave voice channel
function leaveVoiceChannel(guildId) {
    const connection = voiceConnections.get(guildId);
    if (connection) {
        connection.destroy();
        voiceConnections.delete(guildId);
        return true;
    }
    return false;
}

// Function to play sound in voice channel
async function playSound(channel, soundFile) {
    try {
        const guildId = channel.guild.id;
        let connection = voiceConnections.get(guildId);
        
        if (!connection) {
            // Try to join the voice channel if not connected
            const member = channel.guild.members.me;
            if (member.voice.channel) {
                connection = await joinVoiceChannelBot(channel.guild, member.voice.channel);
            } else {
                console.log('Bot not in voice channel, cannot play sound');
                return;
            }
        }

        if (!connection) return;

        const player = createAudioPlayer();
        
        // Create resource
        const resource = createAudioResource(path.join(__dirname, 'sounds', soundFile));
        
        player.play(resource);
        connection.subscribe(player);

        // Disconnect after playing (optional - remove if you want to stay connected)
        player.on('stateChange', (oldState, newState) => {
            if (newState.status === 'idle') {
                // Uncomment the line below if you want to disconnect after each sound
                // connection.destroy();
            }
        });
        
        // Handle connection errors
        connection.on('error', (error) => {
            console.error('Voice connection error:', error);
            voiceConnections.delete(guildId);
        });
        
        connection.on('disconnect', () => {
            console.log(`Voice connection disconnected for guild ${guildId}`);
            voiceConnections.delete(guildId);
        });

    } catch (error) {
        console.error('Error playing sound:', error);
    }
}

// Helper to schedule warning sound relative to timer end
function scheduleWarning(timer, channel) {
    // Clear any existing warning timeout
    if (timer.warningTimeoutId) {
        clearTimeout(timer.warningTimeoutId);
        timer.warningTimeoutId = null;
    }
    
    // Compute remaining time to warning (1 minute before end)
    const warningTime = timer.warningTime ?? (timer.endTime - 60000);
    const remainingToWarning = warningTime - Date.now();
    
    // Only schedule if there's time left and timer longer than 1 minute
    if (remainingToWarning > 0 && timer.duration > 60000) {
        timer.warningTimeoutId = setTimeout(async () => {
            try {
                await playSound(channel, 'cri.mp3');
            } catch (error) {
                console.error('Error playing warning sound:', error);
            }
        }, remainingToWarning);
    }
}

// Function to start a timer
function startTimer(channel, duration, message, timerMessage = null) {
    const channelId = channel.id;
    const guildId = channel.guild.id;
    
    // Check if we can create a new timer
    if (!canCreateTimer(guildId)) {
        console.warn(`Cannot create timer for guild ${guildId} - limit reached`);
        return null;
    }
    
    // Check if this is a new timer (no existing timer in channel)
    const isNewTimer = !activeTimers.has(channelId);
    
    // Clear any existing timer for this channel
    if (activeTimers.has(channelId)) {
        const oldTimer = activeTimers.get(channelId);
        safeCleanupTimer(oldTimer);
    }
    
    const startTime = Date.now();
    const endTime = startTime + duration;
    
    // Create timer object
    const timer = {
        channelId,
        guildId,
        startTime,
        endTime,
        duration,
        message,
        timeoutId: null,
        updateIntervalId: null,
        isPaused: false
    };
    
    // Store timer FIRST to prevent race conditions
    activeTimers.set(channelId, timer);
    
    // Store timer message for updates
    if (timerMessage) {
        if (!timerMessages.has(guildId)) {
            timerMessages.set(guildId, new Map());
        }
        timerMessages.get(guildId).set(channelId, { message: timerMessage });
        
        // Set message flag ONLY for new timers (not restarts)
        if (isNewTimer) {
            setMessageFlag(guildId, channelId, timerMessage.id);
        }
    }
    
    // Set update interval (every 1 second)
    timer.updateIntervalId = setInterval(() => {
        updateTimerMessage(channelId, timer);
    }, 1000);
    
    // Set warning scheduling metadata and timeout (1 minute before end)
    timer.warningTime = endTime - 60000;
    timer.warningRemainingTime = duration > 60000 ? (duration - 60000) : null;
    scheduleWarning(timer, channel);
    
    // Set main timer
    timer.timeoutId = setTimeout(async () => {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🚨 Timer Finished!')
            .setDescription(`**${message}**\n\n⏰ **Time is up!**`)
            .setTimestamp();
        
        await channel.send({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
        
        // Play final alarm
        if (channel.guild.members.me.voice.channel) {
            await playSound(channel, 'end.mp3');
        }
        
        // Clean up
        activeTimers.delete(channelId);
        timerUpdateThrottle.delete(channelId);
        if (timerMessages.has(guildId)) {
            timerMessages.get(guildId).delete(channelId);
            if (timerMessages.get(guildId).size === 0) {
                timerMessages.delete(guildId);
            }
        }
    }, duration);
    
    return timer;
}

// Function to stop timer
function stopTimer(channelId) {
    const timer = activeTimers.get(channelId);
    if (timer) {
        const remainingTime = timer.endTime - Date.now();
        const timerInfo = {
            message: timer.message,
            duration: timer.duration,
            remainingTime: Math.max(0, remainingTime),
            guildId: timer.guildId
        };
        
        clearTimeout(timer.timeoutId);
        if (timer.warningTimeoutId) {
            clearTimeout(timer.warningTimeoutId);
        }
        if (timer.updateIntervalId) {
            clearInterval(timer.updateIntervalId);
        }
        activeTimers.delete(channelId);
        timerUpdateThrottle.delete(channelId);
        
        // Clean up timer messages
        if (timer.guildId && timerMessages.has(timer.guildId)) {
            timerMessages.get(timer.guildId).delete(channelId);
            if (timerMessages.get(timer.guildId).size === 0) {
                timerMessages.delete(timer.guildId);
            }
        }
        return timerInfo;
    }
    return false;
}

client.once('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    logToFile('INFO', `Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('/help for commands', { type: 'WATCHING' });
    
    // Register slash commands
    try {
        const commands = [
            {
                name: 'timer',
                description: 'Start a timer (no duration = default)',
                options: [
                    {
                        name: 'duration',
                        description: 'Timer duration (e.g., 2m, 5m, 1h)',
                        type: 3, // STRING
                        required: false
                    }
                ]
            },
            {
                name: 'set-default',
                description: 'Set default timer duration for this server',
                options: [
                    {
                        name: 'duration',
                        description: 'Default duration (e.g., 2m, 5m, 1h)',
                        type: 3, // STRING
                        required: true
                    }
                ]
            },
            {
                name: 'help',
                description: 'Show bot commands and help'
            },
            {
                name: 'voice-connect',
                description: 'Connect to the voice channel'
            },
            {
                name: 'voice-disconnect',
                description: 'Disconnect from the voice channel'
            },
            {
                name: 'sound-test',
                description: 'Test bot sounds',
                options: [
                    {
                        name: 'type',
                        description: 'Type of sound to test',
                        type: 3, // STRING
                        required: true,
                        choices: [
                            { name: 'Warning sound', value: 'warning' },
                            { name: 'End sound', value: 'end' }
                        ]
                    }
                ]
            },
            {
                name: 'mic-history',
                description: 'Show microphone interaction history'
            },
            {
                name: 'clear-mic-history',
                description: 'Clear microphone interaction history'
            },
            {
                name: 'clear-channel',
                description: 'Clear bot messages from the channel'
            }
        ];
        
        console.log('Registering slash commands...');
        console.log('Commands to register:', commands.map(cmd => cmd.name));
        
        try {
            // Try to register commands globally first
            const registeredCommands = await client.application.commands.set(commands);
            console.log('Global slash commands registered successfully!');
            console.log('Registered commands:', registeredCommands.map(cmd => cmd.name));
            
            // Test if commands are accessible
            const globalCommands = await client.application.commands.fetch();
            console.log('Global commands available:', globalCommands.map(cmd => cmd.name));
        } catch (globalError) {
            console.log('Global registration failed, trying guild-specific registration...');
            console.error('Global error:', globalError.message);
            
            // Try guild-specific registration as fallback
            try {
                const guilds = client.guilds.cache;
                console.log(`Found ${guilds.size} guilds`);
                
                for (const [guildId, guild] of guilds) {
                    try {
                        const guildCommands = await guild.commands.set(commands);
                        console.log(`Guild commands registered for ${guild.name} (${guildId}):`, guildCommands.map(cmd => cmd.name));
                    } catch (guildError) {
                        console.error(`Failed to register commands for guild ${guild.name}:`, guildError.message);
                    }
                }
            } catch (guildError) {
                console.error('Guild registration also failed:', guildError.message);
            }
        }
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('Received SIGINT, cleaning up...');
        logToFile('INFO', 'Received SIGINT, cleaning up...');
        cleanupAllTimers();
        cleanupAllIntervals();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, cleaning up...');
        logToFile('INFO', 'Received SIGTERM, cleaning up...');
        cleanupAllTimers();
        cleanupAllIntervals();
        process.exit(0);
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('Uncaught Exception:', error);
        logToFile('ERROR', `Uncaught Exception: ${error.message}`);
        cleanupAllTimers();
        cleanupAllIntervals();
        process.exit(1);
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        logToFile('ERROR', `Unhandled Rejection: ${reason}`);
    });
    
    // Clean up any existing voice connections from previous sessions
    for (const [guildId, connection] of voiceConnections) {
        try {
            connection.destroy();
        } catch (error) {
            console.error(`Error cleaning up voice connection for guild ${guildId}:`, error);
        }
    }
    voiceConnections.clear();
    
    // Clean up old rate limit entries every 5 minutes
    cleanupIntervals.push(setInterval(() => {
        const now = Date.now();
        for (const [userId, lastCommand] of userCooldowns) {
            if (now - lastCommand > RATE_LIMIT_MS * 10) { // Remove entries older than 10 seconds
                userCooldowns.delete(userId);
            }
        }
    }, 5 * 60 * 1000)); // Every 5 minutes
    
    // Clean up old microphone history entries every 10 minutes
    cleanupIntervals.push(setInterval(() => {
        const now = Date.now();
        for (const [guildId, history] of microphoneUnmuteHistory) {
            // Remove entries older than 24 hours
            const filteredHistory = history.filter(entry => 
                now - entry.timestamp.getTime() < 24 * 60 * 60 * 1000
            );
            
            if (filteredHistory.length === 0) {
                microphoneUnmuteHistory.delete(guildId);
            } else {
                microphoneUnmuteHistory.set(guildId, filteredHistory);
            }
        }
    }, 10 * 60 * 1000)); // Every 10 minutes
    
    // Clean up old command execution tracker entries every minute
    cleanupIntervals.push(setInterval(() => {
        const now = Date.now();
        for (const [key, executions] of commandExecutionTracker) {
            const filtered = executions.filter(time => now - time < 10000);
            if (filtered.length === 0) {
                commandExecutionTracker.delete(key);
            } else {
                commandExecutionTracker.set(key, filtered);
            }
        }
    }, 60000)); // Every minute
    
    // Clean up orphaned timer messages every 15 minutes
    cleanupIntervals.push(setInterval(() => {
        const now = Date.now();
        for (const [guildId, guildMessages] of timerMessages) {
            for (const [channelId, messageData] of guildMessages) {
                // Check if timer still exists
                if (!activeTimers.has(channelId)) {
                    guildMessages.delete(channelId);
                }
            }
            
            // Remove empty guild entries
            if (guildMessages.size === 0) {
                timerMessages.delete(guildId);
            }
        }
    }, 15 * 60 * 1000)); // Every 15 minutes
    
    // Health check every 30 seconds
    cleanupIntervals.push(setInterval(() => {
        const memUsage = process.memoryUsage();
        const memoryUsageMB = memUsage.heapUsed / 1024 / 1024;
        
        console.log(`[HEALTH] Active timers: ${activeTimers.size}, Voice connections: ${voiceConnections.size}, Memory: ${memoryUsageMB.toFixed(2)} MB`);
        
        if (memoryUsageMB > 500) {
            console.warn(`[HEALTH] High memory usage: ${memoryUsageMB.toFixed(2)} MB`);
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
        }
        
        // Check if bot is still responsive
        if (client.ws.ping > 1000) {
            console.warn(`[HEALTH] High ping: ${client.ws.ping}ms`);
        }
    }, 30000)); // Every 30 seconds
});

// Track microphone unmute events
client.on('voiceStateUpdate', (oldState, newState) => {
    // Check if user unmuted their microphone
    if (oldState.mute && !newState.mute) {
        const guildId = newState.guild.id;
        const userId = newState.member.id;
        const username = newState.member.displayName || newState.member.user.username;
        
        // Add to microphone unmute history
        addToMicrophoneHistory(guildId, userId, username);
        
        console.log(`User ${username} unmuted microphone in guild ${guildId}`);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    const { content, channel, guild, author } = message;
    
    // Rate limiting check
    if (isRateLimited(author.id)) {
        return; // Silently ignore rate limited commands
    }
    
    // Global rate limiting check
    if (!checkGlobalRateLimit()) {
        console.warn(`Global rate limit exceeded. Current requests: ${globalRateLimit.requests}`);
        return; // Silently ignore when global limit exceeded
    }
    
    // !cs command - start timer
    if (content.startsWith('!cs')) {
        const args = content.slice(3).trim();
        const duration = parseTime(args, guild.id);
        
        if (duration === null) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Invalid Time Format')
                .setDescription('Use format: `!cs [duration]` or `/timer [duration]`\n\nExamples:\n• `!cs 5m` or `/timer 5m` - 5 minutes\n• `!cs 30s` or `/timer 30s` - 30 seconds\n• `!cs 1h` or `/timer 1h` - 1 hour\n• `!cs` or `/timer` - default time');
            
            return message.reply({ embeds: [embed] });
        }
        
        if (duration < 1000) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Timer Too Short')
                .setDescription('Minimum timer duration is 1 second.');
            
            return message.reply({ embeds: [embed] });
        }
        
        if (duration > 24 * 60 * 60 * 1000) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Timer Too Long')
                .setDescription('Maximum timer duration is 24 hours.');
            
            return message.reply({ embeds: [embed] });
        }
        
        // Check if there's already a timer in this channel
        if (activeTimers.has(channel.id)) {
            // Stop the existing timer
            const oldTimer = activeTimers.get(channel.id);
            clearTimeout(oldTimer.timeoutId);
            if (oldTimer.warningTimeoutId) {
                clearTimeout(oldTimer.warningTimeoutId);
            }
            
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('🔄 Timer Reset')
                .setDescription('Previous timer stopped; starting a new one...');
            
            await message.reply({ embeds: [embed] });
        }
        
        const timerMessage = args ? `Timer: ${args}` : `Timer (default)`;
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('⏰ Timer Started')
            .setDescription(`**${timerMessage}**\n\nDuration: ${formatTime(duration)}\nRemaining: ${formatTime(duration)}\n\nUse \`!cs\` or \`/timer\` again to reset the timer`)
            .setTimestamp();
        
        const reply = await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        
        const timer = startTimer(channel, duration, timerMessage, reply);
        if (!timer) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription(`Maximum number of timers reached!\n\nLimit: ${MAX_TIMERS_PER_GUILD} timers per server`);
            
            await message.reply({ embeds: [errorEmbed] });
            return;
        }
        
        // Flag is now set in startTimer() only for new timers
    }
    
    // !stop command - stop timer
    if (content === '!stop') {
        const timerInfo = stopTimer(channel.id);
        
        if (timerInfo) {
            const defaultTime = defaultTimes.get(guild.id) || 5 * 60 * 1000;
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🛑 Timer Stopped')
                .setDescription(`**${timerInfo.message}**`)
                .addFields(
                    {
                        name: '⏱️ Set Duration',
                        value: formatTime(timerInfo.duration),
                        inline: true
                    },
                    {
                        name: '⏰ Remaining Time',
                        value: formatTime(timerInfo.remainingTime),
                        inline: true
                    },
                    {
                        name: '⚙️ Server Default Time',
                        value: formatTime(defaultTime),
                        inline: true
                    }
                )
                .setTimestamp();
            
            await message.reply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚠️ No Active Timer')
                .setDescription('There is no active timer in this channel.');
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // !status command - check timer status
    if (content === '!status') {
        const timer = activeTimers.get(channel.id);
        
        if (timer) {
            const remaining = timer.endTime - Date.now();
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('⏰ Timer Status')
                .setDescription(`**Active Timer**\n\nRemaining time: ${formatTime(remaining)}`)
                .setTimestamp();
            
            await message.reply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#808080')
                .setTitle('⏰ Timer Status')
                .setDescription('No active timer in this channel.');
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // !set command - set default timer time
    if (content.startsWith('!set cs')) {
        const args = content.slice(7).trim();
        const duration = parseTime(args, guild.id);
        
        if (duration === null) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Invalid Time Format')
                .setDescription('Use format: `!set cs [duration]` or `/set-default <duration>`\n\nExamples:\n• `!set cs 5m` or `/set-default 5m` - set default to 5 minutes\n• `!set cs 30s` or `/set-default 30s` - set default to 30 seconds\n• `!set cs 1h` or `/set-default 1h` - set default to 1 hour');
            
            return message.reply({ embeds: [embed] });
        }
        
        if (duration < 1000) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Timer Too Short')
                .setDescription('Minimum timer duration is 1 second.');
            
            return message.reply({ embeds: [embed] });
        }
        
        if (duration > 24 * 60 * 60 * 1000) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Timer Too Long')
                .setDescription('Maximum timer duration is 24 hours.');
            
            return message.reply({ embeds: [embed] });
        }
        
        defaultTimes.set(guild.id, duration);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Default Time Set')
            .setDescription(`Default timer duration set to: **${formatTime(duration)}**\n\nNow you can use \`!cs\` without providing a duration.`)
            .setTimestamp();
        
        await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
    }
    
    // !join command - join voice channel
    if (content === '!join' || content === '!connect') {
        const member = message.member;
        if (!member.voice.channel) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ You Are Not in a Voice Channel')
                .setDescription('You must be in a voice channel to use this command.');
            
            return message.reply({ embeds: [embed] });
        }
        
        const connection = await joinVoiceChannelBot(guild, member.voice.channel);
        
        if (connection) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🔊 Connected to Voice Channel')
                .setDescription(`Connected to: **${member.voice.channel.name}**`)
                .setTimestamp();
            
            await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
            
            // Automatically call !start after 1 second
            setTimeout(() => {
                // Call !start command directly
                const startMessage = {
                    ...message,
                    content: '!start',
                    reply: async (options) => {
                        return await message.channel.send(options);
                    },
                    member: message.member,
                    guild: message.guild,
                    channel: message.channel,
                    author: message.author
                };
                client.emit('messageCreate', startMessage);
            }, 1000);
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Failed to Connect')
                .setDescription('Could not connect to the voice channel.');
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // !rozlacz command - leave voice channel
    if (content === '!leave' || content === '!disconnect') {
        const left = leaveVoiceChannel(guild.id);
        
        if (left) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🔇 Disconnected from Voice Channel')
                .setDescription('Left the voice channel.')
                .setTimestamp();
            
            await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
            
            // Automatically call !start after 1 second
            setTimeout(() => {
                // Call !start command directly
                const startMessage = {
                    ...message,
                    content: '!start',
                    reply: async (options) => {
                        return await message.channel.send(options);
                    },
                    member: message.member,
                    guild: message.guild,
                    channel: message.channel,
                    author: message.author
                };
                client.emit('messageCreate', startMessage);
            }, 1000);
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚠️ Not in a Voice Channel')
                .setDescription('The bot is not currently in a voice channel.');
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // !test1 command - test warning sound
    if (content === '!test1') {
        // Try to join voice channel first
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            await joinVoiceChannelBot(guild, voiceChannel);
        }
        
        await playSound(channel, 'cri.mp3');
        
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('🔔 Warning Sound Test')
            .setDescription('Playing warning sound...')
            .setTimestamp();
        
        await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
        
        // Auto-trigger !start after 1 second
        setTimeout(() => {
            // Check if command is looping to prevent infinite loops
            if (isCommandLooping(author.id, '!start')) {
                console.warn(`Prevented command loop for user ${author.id} with command !start`);
                return;
            }
            
            const startMessage = {
                ...message,
                content: '!start',
                reply: async (options) => {
                    return await message.channel.send(options);
                },
                member: message.member,
                guild: message.guild,
                channel: message.channel,
                author: message.author
            };
            client.emit('messageCreate', startMessage);
        }, 1000);
    }
    
    // !test2 command - test final sound
    if (content === '!test2') {
        // Try to join voice channel first
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            await joinVoiceChannelBot(guild, voiceChannel);
        }
        
        await playSound(channel, 'end.mp3');
        
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🚨 Final Sound Test')
            .setDescription('Playing final alarm sound...')
            .setTimestamp();
        
        await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
        
        // Auto-trigger !start after 1 second
        setTimeout(() => {
            // Check if command is looping to prevent infinite loops
            if (isCommandLooping(author.id, '!start')) {
                console.warn(`Prevented command loop for user ${author.id} with command !start`);
                return;
            }
            
            const startMessage = {
                ...message,
                content: '!start',
                reply: async (options) => {
                    return await message.channel.send(options);
                },
                member: message.member,
                guild: message.guild,
                channel: message.channel,
                author: message.author
            };
            client.emit('messageCreate', startMessage);
        }, 1000);
    }
    
    // !miclog command - show microphone unmute history
    if (content === '!miclog') {
        const history = getMicrophoneHistory(guild.id);
        
        if (history.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#808080')
                .setTitle('🎤 Microphone History')
                .setDescription('No one has unmuted yet.')
                .setTimestamp();
            
            await message.reply({ embeds: [embed] });
            
            // Auto-trigger !start after 1 second
            setTimeout(() => {
                // Check if command is looping to prevent infinite loops
                if (isCommandLooping(author.id, '!start')) {
                    console.warn(`Prevented command loop for user ${author.id} with command !start`);
                    return;
                }
                
                const startMessage = {
                    ...message,
                    content: '!start',
                    reply: async (options) => {
                        return await message.channel.send(options);
                    },
                    member: message.member,
                    guild: message.guild,
                    channel: message.channel,
                    author: message.author
                };
                client.emit('messageCreate', startMessage);
            }, 1000);
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('🎤 Last 10 Users Who Unmuted')
            .setDescription(history.map((entry, index) => 
                `${index + 1}. **${entry.username}** - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
            ).join('\n'))
            .setTimestamp();
        
        await message.reply({ embeds: [embed] });
        
        // Auto-trigger !start after 1 second
        setTimeout(() => {
            // Check if command is looping to prevent infinite loops
            if (isCommandLooping(author.id, '!start')) {
                console.warn(`Prevented command loop for user ${author.id} with command !start`);
                return;
            }
            
            const startMessage = {
                ...message,
                content: '!start',
                reply: async (options) => {
                    return await message.channel.send(options);
                },
                member: message.member,
                guild: message.guild,
                channel: message.channel,
                author: message.author
            };
            client.emit('messageCreate', startMessage);
        }, 1000);
    }
    
    // !clearvoicehistory command - clear microphone unmute history
    if (content === '!clearvoicehistory') {
        clearMicrophoneHistory(guild.id);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ History Cleared')
            .setDescription('Microphone history has been cleared.')
            .setTimestamp();
        
        await message.reply({ embeds: [embed] });
        
        // Auto-trigger !start after 1 second
        setTimeout(() => {
            // Check if command is looping to prevent infinite loops
            if (isCommandLooping(author.id, '!start')) {
                console.warn(`Prevented command loop for user ${author.id} with command !start`);
                return;
            }
            
            const startMessage = {
                ...message,
                content: '!start',
                reply: async (options) => {
                    return await message.channel.send(options);
                },
                member: message.member,
                guild: message.guild,
                channel: message.channel,
                author: message.author
            };
            client.emit('messageCreate', startMessage);
        }, 1000);
    }
    
    // !cleanup command - clean up voice connections
    if (content === '!cleanup') {
        let cleanedCount = 0;
        
        for (const [guildId, connection] of voiceConnections) {
            try {
                connection.destroy();
                cleanedCount++;
                console.log(`Cleaned up voice connection for guild ${guildId}`);
            } catch (error) {
                console.error(`Error cleaning up voice connection for guild ${guildId}:`, error);
            }
        }
        
        voiceConnections.clear();
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Cleanup Complete')
            .setDescription(`Cleared ${cleanedCount} voice connections.`)
            .setTimestamp();
        
        await message.reply({ embeds: [embed] });
    }
    
    // !start command - show help
    if (content === '!start') {
        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('🔔 Timer Bot Commands')
            .setDescription('Discord bot with timers and voice notifications!')
            .addFields(
                {
                    name: '🎛️ Buttons (Recommended)',
                    value: '▶️ **Start Timer** - Start with default time\n⏹️ **Stop** - Stop the active timer\n🔗 **Connect to Voice** - Join the voice channel\n🔌 **Disconnect from Voice** - Leave the voice channel\n🎤 **Microphone History** - Show last 10 users\n🗑️ **Clear History** - Clear microphone history\n🧹 **Clear Channel** - Remove bot messages from channel\n⚙️ **Settings** - Set default time\n🚀 **Help** - Show this help',
                    inline: false
                },
                {
                    name: '🔔 Voice Notifications',
                    value: '🔔 Warning sound: 1 minute before the end\n🚨 Final alarm: when the timer ends\n\n**🚨 ⚠️ IMPORTANT ⚠️ 🚨**\n**The bot must be in a voice channel to play sounds!**\n**Press the "🔗 Connect to voice channel" button!**',
                    inline: false
                }
            )
            .setFooter({ text: 'Created by amadosx 🍒' })
            .setTimestamp();
        
        await message.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
    }
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
    console.log(`[INTERACTION] Received ${interaction.type} interaction: ${interaction.customId || interaction.commandName}`);
    
    // Handle slash commands
    if (interaction.isCommand()) {
        const { commandName, options, channel, guild, user } = interaction;
        
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) {
            console.log(`[INTERACTION] Slash command ${commandName} already replied/deferred, skipping`);
            return;
        }
        
        // Rate limiting check
        if (isRateLimited(user.id)) {
            try {
                await interaction.reply({ 
                    content: '⏰ Please wait a moment before the next command!', 
                    ephemeral: true 
                });
            } catch (error) {
                console.error('Error replying to rate limited slash command:', error.message);
            }
            return;
        }
        
        try {
            switch (commandName) {
                case 'timer': {
                    const durationStr = options.getString('duration');
                    const duration = durationStr ? parseTime(durationStr, guild.id) : (defaultTimes.get(guild.id) || 5 * 60 * 1000);
                    
                    if (duration <= 0) {
                        await interaction.reply({ 
                            content: '❌ Invalid time format! Use e.g. 2m, 5m, 1h', 
                            ephemeral: true 
                        });
                        return;
                    }
                    
                    // Check if there's already a timer
                    if (activeTimers.has(channel.id)) {
                        const oldTimer = activeTimers.get(channel.id);
                        clearTimeout(oldTimer.timeoutId);
                        if (oldTimer.warningTimeoutId) {
                            clearTimeout(oldTimer.warningTimeoutId);
                        }
                    }
                    
                    const timerMessage = durationStr ? `Timer (${formatTime(duration)})` : `Timer (default)`;
                    
                    const embed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('⏰ Timer Started')
                        .setDescription(`**${timerMessage}**\n\nDuration: ${formatTime(duration)}\nRemaining: ${formatTime(duration)}`)
                        .setTimestamp();
                    
                    const reply = await interaction.reply({ 
                        embeds: [embed], 
                        components: [...createTimerButtons(), ...createQuickTimerButtons(false)] 
                    });
                    
                    // Store the message for live updates
                    const message = await reply.fetch();
                    if (!timerMessages.has(guild.id)) {
                        timerMessages.set(guild.id, new Map());
                    }
                    timerMessages.get(guild.id).set(channel.id, { message });
                    
                    // Start the timer with proper args
                    startTimer(channel, duration, timerMessage, message);
                    break;
                }
                
                case 'set-default': {
                    const timeStr = options.getString('duration');
                    const duration = parseTime(timeStr, guild.id);
                    
                    if (duration <= 0) {
                        await interaction.reply({ 
                            content: '❌ Invalid time format! Use e.g. 2m, 5m, 1h', 
                            ephemeral: true 
                        });
                        return;
                    }
                    
                    defaultTimes.set(guild.id, duration);
                    
                    const embed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('✅ Default Time Set')
                        .setDescription(`Default timer duration set to: ${formatTime(duration)}\n\nNow you can use \`/timer\` without providing a duration.`)
                        .setTimestamp();
                    
                    await interaction.reply({ 
                        embeds: [embed], 
                        components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                    });
                    break;
                }
                
                case 'help': {
                    // Check user permissions
                    const member = await guild.members.fetch(interaction.user.id);
                    const hasPermissions = hasTimerBotUserRole(member);
                    
                    const embed = new EmbedBuilder()
                        .setColor('#0099FF')
                        .setTitle('🔔 Timer Bot Commands')
                        .setDescription('Discord bot with timers and voice notifications!')
                        .addFields(
                            {
                                name: '🔔 Voice Notifications',
                                value: '🔔 Warning sound: 1 minute before the end\n🚨 Final alarm: when the timer ends\n\n**🚨 ⚠️ IMPORTANT ⚠️ 🚨**\n**The bot must be in a voice channel to play sounds!**',
                                inline: false
                            }
                        )
                        .setFooter({ text: 'Created by amadosx 🍒' })
                        .setTimestamp();
                    
                    // Always show the same content, but only add buttons for users with permissions
                    embed.addFields({
                        name: '🎛️ Buttons (Recommended)',
                        value: '▶️ **Start Timer** - Start with default time\n⏹️ **Stop** - Stop the active timer\n🔗 **Connect to Voice** - Join the voice channel\n🔌 **Disconnect from Voice** - Leave the voice channel\n🎤 **Microphone History** - Show last 10 users\n🗑️ **Clear History** - Clear microphone history\n🧹 **Clear Channel** - Remove bot messages from channel\n⚙️ **Settings** - Set default time\n🚀 **Help** - Show this help',
                        inline: false
                    });
                    
                    // Only show buttons if user has permissions
                    const components = hasPermissions ? 
                        [...createTimerButtons(true), ...createQuickTimerButtons(true)] : 
                        [];
                    
                    await interaction.reply({ 
                        embeds: [embed], 
                        components: components
                    });
                    break;
                }
                
                case 'voice-connect': {
                    if (!guild.members.me.voice.channel) {
                        const voiceChannel = guild.members.cache.get(user.id)?.voice?.channel;
                        if (!voiceChannel) {
                            await interaction.reply({ 
                                content: '❌ You must be in a voice channel!', 
                                ephemeral: true 
                            });
                            return;
                        }
                        
                        const connection = joinVoiceChannel({
                            channelId: voiceChannel.id,
                            guildId: guild.id,
                            adapterCreator: guild.voiceAdapterCreator,
                        });
                        
                        voiceConnections.set(guild.id, connection);
                        
                        const embed = new EmbedBuilder()
                            .setColor('#00FF00')
                            .setTitle('🔊 Connected to Voice Channel')
                            .setDescription(`Connected to: **${voiceChannel.name}**`)
                            .setTimestamp();
                        
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                        });
                    } else {
                        await interaction.reply({ 
                            content: '❌ Bot is already in a voice channel!', 
                            ephemeral: true 
                        });
                    }
                    break;
                }
                
                case 'voice-disconnect': {
                    const left = leaveVoiceChannel(guild.id);
                    if (left) {
                        const embed = new EmbedBuilder()
                            .setColor('#FF0000')
                            .setTitle('🔇 Left Voice Channel')
                            .setDescription('Bot left the voice channel')
                            .setTimestamp();
                        
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                        });
                    } else {
                        await interaction.reply({ 
                            content: '❌ Bot is not in any voice channel!', 
                            ephemeral: true 
                        });
                    }
                    break;
                }
                
                case 'sound-test': {
                    const soundType = options.getString('type');
                    const soundFile = soundType === 'warning' ? 'cri.mp3' : 'end.mp3';
                    
                    if (!guild.members.me.voice.channel) {
                        await interaction.reply({ 
                            content: '❌ The bot must be in a voice channel! Use `/voice-connect`', 
                            ephemeral: true 
                        });
                        return;
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle(soundType === 'warning' ? '🔔 Warning Sound Test' : '🚨 Final Sound Test')
                        .setDescription('Playing sound...')
                        .setTimestamp();
                    
                    await interaction.reply({ 
                        embeds: [embed], 
                        components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                    });
                    
                    playSound(channel, soundFile);
                    break;
                }
                
                case 'mic-history': {
                    const history = microphoneUnmuteHistory.get(guild.id) || [];
                    if (history.length === 0) {
                        await interaction.reply({ 
                            content: '📝 Microphone History\n\nNo one has unmuted yet.', 
                            ephemeral: true 
                        });
                        return;
                    }
                    
                    const historyText = history.map((entry, index) => 
                        `${index + 1}. <@${entry.userId}> - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
                    ).join('\n');
                    
                    const embed = new EmbedBuilder()
                        .setColor('#0099FF')
                        .setTitle('📝 Microphone History')
                        .setDescription(historyText)
                        .setTimestamp();
                    
                    await interaction.reply({ 
                        embeds: [embed], 
                        components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                    });
                    break;
                }
                
                case 'clear-mic-history': {
                    microphoneUnmuteHistory.set(guild.id, []);
                    await interaction.reply({ 
                        content: '✅ Microphone history cleared!', 
                        ephemeral: true 
                    });
                    break;
                }
                
                case 'clear-channel': {
                    // Stop all timers in this channel
                    const timersStopped = stopAllTimersInChannel(channel.id);
                    console.log(`Stopped ${timersStopped} timers before clearing messages`);
                    
                    // Leave voice channel if connected
                    const left = leaveVoiceChannel(guild.id);
                    if (left) {
                        console.log('Bot disconnected from voice channel before clearing messages');
                    }
                    
                    // Get all messages in the channel (up to 100 for bulk delete)
                    const messages = await channel.messages.fetch({ limit: 100 });
                    let deletedCount = 0;
                    
                    console.log(`Found ${messages.size} messages to check`);
                    
                    // Separate messages into different categories
                    const botMessagesToDelete = [];
                    const userCommandsToDelete = [];
                    const messagesToKeep = [];
                    
                    for (const message of messages.values()) {
                        // Don't delete pinned messages
                        if (message.pinned) {
                            console.log('Skipping pinned message');
                            messagesToKeep.push(message);
                            continue;
                        }
                        
                        // Bot's own messages
                        if (message.author.id === client.user.id) {
                            console.log(`Marking bot message for deletion: "${message.content?.substring(0, 50)}..."`);
                            botMessagesToDelete.push(message);
                        }
                        // User messages that are bot commands
                        else if (message.content.startsWith('!')) {
                            // Don't delete !cs commands without arguments (default time commands)
                            if (message.content === '!cs' || message.content === '!start') {
                                console.log(`Skipping default command: "${message.content}"`);
                                messagesToKeep.push(message);
                                continue;
                            }
                            
                            console.log(`Marking user command for deletion: "${message.content}"`);
                            userCommandsToDelete.push(message);
                        }
                        else {
                            messagesToKeep.push(message);
                        }
                    }
                    
                    // Use bulk delete for bot messages (up to 100 at once)
                    if (botMessagesToDelete.length > 0) {
                        try {
                            const botMessageIds = botMessagesToDelete.map(m => m.id);
                            console.log(`Bulk deleting ${botMessageIds.length} bot messages...`);
                            await channel.bulkDelete(botMessageIds);
                            deletedCount += botMessageIds.length;
                        } catch (error) {
                            console.log(`Bulk delete failed, falling back to individual deletion: ${error.message}`);
                            // Fallback to individual deletion
                            for (const message of botMessagesToDelete) {
                                try {
                                    await message.delete();
                                    deletedCount++;
                                } catch (deleteError) {
                                    console.log(`Could not delete bot message: ${deleteError.message}`);
                                }
                            }
                        }
                    }
                    
                    // Try to delete user commands individually (bot might not have permission)
                    for (const message of userCommandsToDelete) {
                        try {
                            console.log(`Deleting user command: "${message.content}"`);
                            await message.delete();
                            deletedCount++;
                        } catch (permError) {
                            console.log(`Cannot delete user message (missing permissions): "${message.content}"`);
                        }
                    }
                    
                    // Send a simple confirmation message that will be deleted after 2 seconds
                    const embed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('✅ Cleanup Complete')
                        .setDescription(`Deleted ${deletedCount} messages.\n\n**Kept:**\n• Pinned messages\n• Commands \`!cs\` and \`!start\` without arguments\n• User messages (if bot lacks permission to delete)`)
                        .setTimestamp();
                    
                    const reply = await interaction.reply({ 
                        embeds: [embed], 
                        components: [...createTimerButtons(), ...createQuickTimerButtons()] 
                    });
                    
                    // Delete the confirmation message after 2 seconds
                    setTimeout(async () => {
                        try {
                            const message = await reply.fetch();
                            await message.delete();
                        } catch (error) {
                            console.log('Could not delete confirmation message:', error.message);
                        }
                    }, 2000);
                    break;
                }
                
                default:
                    await interaction.reply({ 
                        content: '❌ Unknown command!', 
                        ephemeral: true 
                    });
            }
        } catch (error) {
            console.error('Error handling slash command:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ An error occurred while executing the command!', 
                        ephemeral: true 
                    });
                }
            } catch (replyError) {
                console.error('Error replying to slash command error:', replyError.message);
            }
        }
        return;
    }
    
    // Handle button interactions
    if (!interaction.isButton()) return;
    
    const { customId, channel, guild, user } = interaction;
    
    // Check if interaction is still valid
    if (interaction.replied || interaction.deferred) {
        console.log('Interaction already replied/deferred, skipping');
        return;
    }
    
    // Rate limiting check
    if (isRateLimited(user.id)) {
        try {
            await interaction.reply({ 
                content: '⏰ Please wait a moment before the next command!', 
                ephemeral: true 
            });
        } catch (error) {
            console.error('Error replying to rate limited interaction:', error.message);
        }
        return;
    }
    
    // Global rate limiting check
    if (!checkGlobalRateLimit()) {
        console.warn(`Global rate limit exceeded for interaction. Current requests: ${globalRateLimit.requests}`);
        try {
            await interaction.reply({ 
                content: '⏰ The bot is currently overloaded. Please try again shortly!', 
                ephemeral: true 
            });
        } catch (error) {
            console.error('Error replying to global rate limited interaction:', error.message);
        }
        return;
    }
    
    // Wrap all button handlers in try-catch to prevent crashes
    try {
        // Timer control buttons
        if (customId === 'timer_start') {
            // Check if interaction is still valid
            if (interaction.replied || interaction.deferred) return;
            
            // Check if user has Timer Bot User role
            const member = await guild.members.fetch(interaction.user.id);
            if (!hasTimerBotUserRole(member)) {
                // Silently ignore users without permissions
                return;
            }
            
            const defaultTime = defaultTimes.get(guild.id) || 5 * 60 * 1000;
            const timerMessage = `Timer (default)`;
            
            // Check if there's already a timer
            if (activeTimers.has(channel.id)) {
                const oldTimer = activeTimers.get(channel.id);
            clearTimeout(oldTimer.timeoutId);
            if (oldTimer.warningTimeoutId) {
                clearTimeout(oldTimer.warningTimeoutId);
            }
        }
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('⏰ Timer Started')
            .setDescription(`**${timerMessage}**\n\nDuration: ${formatTime(defaultTime)}\nRemaining: ${formatTime(defaultTime)}`)
            .setTimestamp();
        
        const reply = await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        
        // Store message for updates (interaction.reply returns different object)
        let messageToStore = null;
        if (reply && reply.fetch) {
            messageToStore = await reply.fetch();
        }
        
        const timer = startTimer(channel, defaultTime, timerMessage, messageToStore);
        if (!timer) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription(`Maximum number of timers reached!\n\nLimit: ${MAX_TIMERS_PER_GUILD} timers per server`);
            
            await interaction.followUp({ embeds: [errorEmbed] });
            return;
        }
        
        // Flag is now set in startTimer() only for new timers
    }
    
    else if (customId === 'timer_pause') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const timer = activeTimers.get(channel.id);
        if (!timer) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ No Active Timer')
                .setDescription('There is no active timer to pause.')
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
            return;
        }
        
        if (timer.isPaused) {
            // Resume timer
            const remainingTime = timer.pausedRemainingTime || 0;
            if (remainingTime <= 0) {
                // Timer already expired, clean up
                activeTimers.delete(channel.id);
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('⏰ Timer Expired')
                    .setDescription('The timer ended while it was paused.')
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                return;
            }
            
            // Resume timer - use the stored remaining time
            timer.isPaused = false;
            timer.endTime = Date.now() + remainingTime;
            timer.warningTime = timer.endTime - 60000;
            timer.warningRemainingTime = remainingTime > 60000 ? (remainingTime - 60000) : null;
            
            // Clear pause data
            delete timer.pausedAt;
            delete timer.pausedRemainingTime;
            
            // Restart the update interval
            timer.updateIntervalId = setInterval(() => {
                updateTimerMessage(channel.id, timer);
            }, 1000);
            
            
            // Restart the main timeout
            timer.timeoutId = setTimeout(async () => {
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('🚨 Timer Finished!')
                    .setDescription(`**${timer.message}**\n\n⏰ **Time is up!**`)
                    .setTimestamp();
                
                await channel.send({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
                
                // Play final alarm
                if (channel.guild.members.me.voice.channel) {
                    await playSound(channel, 'end.mp3');
                }
                
                // Clean up
                activeTimers.delete(channel.id);
                if (timerMessages.has(guild.id)) {
                    timerMessages.get(guild.id).delete(channel.id);
                    if (timerMessages.get(guild.id).size === 0) {
                        timerMessages.delete(guild.id);
                    }
                }
            }, remainingTime);
            
            // Reschedule warning based on new end time
            scheduleWarning(timer, channel);
            
            // Update the original timer message instead of creating new one
            const guildId = timer.guildId;
            if (timerMessages.has(guildId)) {
                const guildMessages = timerMessages.get(guildId);
                const messageData = guildMessages.get(channel.id);
                if (messageData && messageData.message) {
                    const embed = new EmbedBuilder()
                        .setColor('#00FF00')
                            .setTitle('⏰ Timer Active')
                            .setDescription(`**${timer.message}**\n\nDuration: ${formatTime(timer.duration)}\nRemaining: ${formatTime(remainingTime)}`)
                        .setTimestamp();
                    
                    await messageData.message.edit({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                    await interaction.deferUpdate();
                    return;
                }
            }
            
            // Fallback if no original message found
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('▶️ Timer Resumed')
                .setDescription(`**${timer.message}**\n\nRemaining: ${formatTime(remainingTime)}`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        } else {
            // Pause timer
            timer.isPaused = true;
            const remainingTime = timer.endTime - Date.now();
            
            // Store the remaining time and pause timestamp
            timer.pausedAt = Date.now();
            timer.pausedRemainingTime = Math.max(0, remainingTime); // Ensure non-negative
            timer.warningRemainingTime = (timer.endTime - 60000) - Date.now();
            
            // Clear timeouts and intervals
            clearTimeout(timer.timeoutId);
            if (timer.warningTimeoutId) {
                clearTimeout(timer.warningTimeoutId);
                timer.warningTimeoutId = null;
            }
            if (timer.updateIntervalId) {
                clearInterval(timer.updateIntervalId);
            }
            
            
            // Update the original timer message instead of creating new one
            const guildId = timer.guildId;
            if (timerMessages.has(guildId)) {
                const guildMessages = timerMessages.get(guildId);
                const messageData = guildMessages.get(channel.id);
                if (messageData && messageData.message) {
                    const embed = new EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle('⏸️ Timer Paused')
                        .setDescription(`**${timer.message}**\n\nDuration: ${formatTime(timer.duration)}\nRemaining: ${formatTime(remainingTime)}`)
                        .setTimestamp();
                    
                    await messageData.message.edit({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                    await interaction.deferUpdate();
                    return;
                }
            }
            
            // Fallback if no original message found
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⏸️ Timer Paused')
                .setDescription(`**${timer.message}**\n\nRemaining: ${formatTime(remainingTime)}`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        }
    }
    
    else if (customId === 'timer_stop') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const timerInfo = stopTimer(channel.id);
        
        if (timerInfo) {
            const defaultTime = defaultTimes.get(guild.id) || 5 * 60 * 1000;
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🛑 Timer Stopped')
                .setDescription(`**${timerInfo.message}**`)
                .addFields(
                    {
                        name: '⏱️ Set Duration',
                        value: formatTime(timerInfo.duration),
                        inline: true
                    },
                    {
                        name: '⏰ Remaining Time',
                        value: formatTime(timerInfo.remainingTime),
                        inline: true
                    },
                    {
                        name: '⚙️ Server Default Time',
                        value: formatTime(defaultTime),
                        inline: true
                    }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚠️ Brak Aktywnego Timera')
                .setDescription('W tym kanale nie ma aktywnego timera.');
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        }
    }
    
    
    else if (customId === 'test_warning_sound') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        try {
            // Play warning sound
            await playSound(channel, 'cri.mp3');
            
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('🔔 Reminder Sound Test')
                .setDescription('Playing warning sound...')
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            // Create settings buttons for return
            const settingsRow1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_2m')
                        .setLabel('2m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_4m')
                        .setLabel('4m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_5m')
                        .setLabel('5m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_6m')
                        .setLabel('6m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_40m')
                        .setLabel('40m')
                        .setStyle(ButtonStyle.Primary)
                );
            
            const settingsRow2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_manual')
                        .setLabel('Manual')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('test_warning_sound')
                        .setLabel('🔔 Reminder Test')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('test_end_sound')
                        .setLabel('🔚 End Test')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('back_to_main')
                        .setLabel('⬅️ Back')
                        .setStyle(ButtonStyle.Secondary)
                );
            
            await interaction.reply({ embeds: [embed], components: [settingsRow1, settingsRow2] });
        } catch (error) {
            console.error('Error playing warning sound:', error);
            
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Playback Error')
                .setDescription('Could not play the warning sound.')
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            // Create settings buttons for return
            const settingsRow1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_2m')
                        .setLabel('2m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_4m')
                        .setLabel('4m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_5m')
                        .setLabel('5m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_6m')
                        .setLabel('6m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_40m')
                        .setLabel('40m')
                        .setStyle(ButtonStyle.Primary)
                );
            
            const settingsRow2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_manual')
                        .setLabel('Manual')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('test_warning_sound')
                        .setLabel('🔔 Reminder Test')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('test_end_sound')
                        .setLabel('🔚 End Test')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('back_to_main')
                        .setLabel('⬅️ Back')
                        .setStyle(ButtonStyle.Secondary)
                );
            
            await interaction.reply({ embeds: [embed], components: [settingsRow1, settingsRow2] });
        }
    }
    
    else if (customId === 'test_end_sound') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        try {
            // Play end sound
            await playSound(channel, 'end.mp3');
            
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🔚 Final Sound Test')
                .setDescription('Playing final sound...')
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            // Create settings buttons for return
            const settingsRow1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_2m')
                        .setLabel('2m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_4m')
                        .setLabel('4m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_5m')
                        .setLabel('5m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_6m')
                        .setLabel('6m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_40m')
                        .setLabel('40m')
                        .setStyle(ButtonStyle.Primary)
                );
            
            const settingsRow2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_manual')
                        .setLabel('Manual')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('test_warning_sound')
                        .setLabel('🔔 Reminder Test')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('test_end_sound')
                        .setLabel('🔚 End Test')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('back_to_main')
                        .setLabel('⬅️ Back')
                        .setStyle(ButtonStyle.Secondary)
                );
            
            await interaction.reply({ embeds: [embed], components: [settingsRow1, settingsRow2] });
        } catch (error) {
            console.error('Error playing end sound:', error);
            
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Playback Error')
                .setDescription('Could not play the final sound.')
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            // Create settings buttons for return
            const settingsRow1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_2m')
                        .setLabel('2m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_4m')
                        .setLabel('4m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_5m')
                        .setLabel('5m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_6m')
                        .setLabel('6m')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('quick_40m')
                        .setLabel('40m')
                        .setStyle(ButtonStyle.Primary)
                );
            
            const settingsRow2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('quick_manual')
                        .setLabel('Manual')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('test_warning_sound')
                        .setLabel('🔔 Reminder Test')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('test_end_sound')
                        .setLabel('🔚 End Test')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('back_to_main')
                        .setLabel('⬅️ Back')
                        .setStyle(ButtonStyle.Secondary)
                );
            
            await interaction.reply({ embeds: [embed], components: [settingsRow1, settingsRow2] });
        }
    }
    
    else if (customId === 'back_to_main') {
        // Check if interaction is still valid - only return if already replied
        if (interaction.replied) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Check if there's an active timer
        const timer = activeTimers.get(channel.id);
        
        if (timer) {
            // Return to active timer - update the main timer message instead of creating new one
            // Use deferUpdate to handle interaction silently without creating a message
            if (!interaction.replied && !interaction.deferred) {
                try {
                    await interaction.deferUpdate();
                } catch (updateError) {
                    console.error('Error deferring update:', updateError);
                    return; // Exit if we can't handle the interaction
                }
            }
            
            const guildId = timer.guildId;
            let messageData = null;
            
            if (timerMessages.has(guildId)) {
                messageData = timerMessages.get(guildId).get(channel.id);
            }
            
            if (messageData && messageData.message) {
                // Calculate remaining time based on pause state
                let remaining;
                if (timer.isPaused && timer.pausedRemainingTime) {
                    remaining = timer.pausedRemainingTime;
                } else {
                    remaining = timer.endTime - Date.now();
                }
                
                const embed = new EmbedBuilder()
                    .setColor(timer.isPaused ? '#FFA500' : '#00FF00')
                    .setTitle(timer.isPaused ? '⏸️ Timer Paused' : '⏰ Timer Active')
                    .setDescription(`**${timer.message}**\n\nDuration: ${formatTime(timer.duration)}\nRemaining: ${formatTime(remaining)}`)
                    .setTimestamp();
                
                try {
                    // Check if timer message still exists
                    try {
                        const fetchedMessage = await messageData.message.fetch();
                        
                        // Update timer message with current time
                        await messageData.message.edit({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                        
                        // Cleanup all messages from flag onwards
                        await cleanupMessagesFromFlag(channel, guildId, channel.id);
                        
                        // Interaction is already handled by reply, no further action needed
                        
                    } catch (fetchError) {
                        console.error('Timer message no longer exists:', fetchError.message);
                        // If timer message doesn't exist, create a new one
                        const newTimerMessage = await messageData.message.channel.send({ 
                            embeds: [embed], 
                            components: [...createTimerButtons(), ...createQuickTimerButtons(false)] 
                        });
                        
                        // Update timerMessages with new message
                        const newGuildId = newTimerMessage.guildId;
                        if (!timerMessages.has(newGuildId)) {
                            timerMessages.set(newGuildId, new Map());
                        }
                        timerMessages.get(newGuildId).set(channel.id, {
                            message: newTimerMessage
                        });
                        
                        // Cleanup all messages from flag onwards
                        await cleanupMessagesFromFlag(channel, guildId, channel.id);
                        
                        // Interaction is already handled by reply, no further action needed
                    }
                } catch (error) {
                    console.error('Error handling back to main:', error);
                    // Error is already logged, interaction was already replied to with emoji
                }
            } else {
                // If no message data, create a new timer message
                const remaining = timer.endTime - Date.now();
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                .setTitle('⏰ Timer Active')
                .setDescription(`**${timer.message}**\n\nDuration: ${formatTime(timer.duration)}\nRemaining: ${formatTime(remaining)}`)
                    .setTimestamp();
                
                // Create a new timer message since no message data exists
                const newMessage = await channel.send({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                
                // Store the new message for updates
                if (!timerMessages.has(guild.id)) {
                    timerMessages.set(guild.id, new Map());
                }
                timerMessages.get(guild.id).set(channel.id, { message: newMessage });
            }
        } else {
            // Return to main help menu
            const embed = new EmbedBuilder()
                .setColor('#0099FF')
                .setTitle('🔔 Timer Bot Commands')
                .setDescription('Discord bot with timers and voice notifications!')
                .addFields(
                    {
                        name: '🎛️ Buttons (Recommended)',
                        value: '▶️ **Start Timer** - Start with default time\n⏹️ **Stop** - Stop the active timer\n🔗 **Connect to Voice** - Join the voice channel\n🔌 **Disconnect from Voice** - Leave the voice channel\n🎤 **Microphone History** - Show last 10 users\n🗑️ **Clear History** - Clear microphone history\n🧹 **Clear Channel** - Remove bot messages from channel\n⚙️ **Settings** - Set default time\n🚀 **Help** - Show this help',
                        inline: false
                    },
                    {
                        name: '🔔 Voice Notifications',
                        value: '🔔 Warning sound: 1 minute before the end\n🚨 Final alarm: when the timer ends\n\n**🚨 ⚠️ IMPORTANT ⚠️ 🚨**\n**The bot must be in a voice channel to play sounds!**\n**Press the "🔗 Connect to voice channel" button!**',
                        inline: false
                    }
                )
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons()] });
        }
    }
    
    else if (customId === 'timer_set') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('⚙️ Timer Settings')
            .setDescription('Choose an option below:')
            .addFields(
                {
                    name: '⏰ Set Default Time',
                    value: 'Click a button below to set the default time:\n• **2m** - 2 minutes\n• **4m** - 4 minutes\n• **5m** - 5 minutes\n• **40m** - 40 minutes\n• **Manual** - manual setup instructions',
                    inline: false
                },
                {
                    name: '🔊 Sound Tests',
                    value: 'Test notification sounds:\n• **Reminder Test** - warning sound\n• **End Test** - final sound',
                    inline: false
                },
                {
                    name: 'Manual Setup',
                    value: 'Use command: `!set cs [duration]`\n\nExamples:\n• `!set cs 5m` - 5 minutes\n• `!set cs 30s` - 30 seconds\n• `!set cs 1h` - 1 hour',
                    inline: false
                }
            )
            .setFooter({ text: 'Created by amadosx 🍒' })
            .setTimestamp();
        
        // Create settings buttons
        const settingsRow1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('quick_2m')
                    .setLabel('2m')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('quick_4m')
                    .setLabel('4m')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('quick_5m')
                    .setLabel('5m')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('quick_6m')
                    .setLabel('6m')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('quick_40m')
                    .setLabel('40m')
                    .setStyle(ButtonStyle.Primary)
            );
        
        const settingsRow2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('quick_manual')
                    .setLabel('Manual')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('test_warning_sound')
                    .setLabel('🔔 Reminder Test')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('test_end_sound')
                    .setLabel('🔚 End Test')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('back_to_main')
                    .setLabel('⬅️ Back')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await interaction.reply({ embeds: [embed], components: [settingsRow1, settingsRow2] });
    }
    
    else if (customId === 'voice_history') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const history = getMicrophoneHistory(guild.id);
        
        if (history.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#808080')
                .setTitle('🎤 Microphone History')
                .setDescription('No one has unmuted yet.');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(false) });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('🎤 Last 10 Users Who Unmuted')
            .setDescription(history.map((entry, index) => 
                `${index + 1}. **${entry.username}** - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
            ).join('\n'))
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true) });
    }
    
    else if (customId === 'clear_voice_history') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        clearMicrophoneHistory(guild.id);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ History Cleared')
            .setDescription('Microphone history has been cleared.');
        
        await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
    }
    
    else if (customId === 'mute_user') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Check if user has moderator permissions
        if (!hasTimerBotUserRole(member)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Insufficient Permissions')
                .setDescription('You do not have permission to mute users.\nRequired: Moderator or Administrator');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true), ephemeral: true });
            return;
        }
        
        // Get microphone history
        const history = getMicrophoneHistory(guild.id);
        if (history.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ No History')
                .setDescription('No users in microphone history to mute.');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(false), ephemeral: true });
            return;
        }
        
        // Create user selection embed
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('🔇 Select User to Mute')
            .setDescription('Choose a user from the list below:\n\n' + 
                history.map((entry, index) => 
                    `${index + 1}. **${entry.username}** - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
                ).join('\n') + 
                '\n\n**Note:** This mute applies to the microphone only.')
            .setTimestamp();
        
        // Create user selection buttons (max 5 users due to Discord limit)
        const userButtons = [];
        const maxUsers = Math.min(5, history.length);
        
        for (let i = 0; i < maxUsers; i++) {
            const entry = history[i];
            userButtons.push(
                new ButtonBuilder()
                    .setCustomId(`mute_user_${entry.userId}`)
                    .setLabel(`${i + 1}. ${entry.username}`)
                    .setStyle(ButtonStyle.Danger)
            );
        }
        
        const row1 = new ActionRowBuilder().addComponents(...userButtons);
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_voice_history')
                    .setLabel('⬅️ Back to History')
                    .setStyle(ButtonStyle.Primary)
            );
        
        await interaction.reply({ embeds: [embed], components: [row1, row2] });
    }
    
    else if (customId.startsWith('mute_user_')) {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Check if user has moderator permissions
        if (!hasTimerBotUserRole(member)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Insufficient Permissions')
                .setDescription('You do not have permission to mute users.');
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
        
        const userId = customId.replace('mute_user_', '');
        
        try {
            // Fetch the user to mute
            const targetMember = await guild.members.fetch(userId);
            
            if (!targetMember) {
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Error')
                    .setDescription('Unable to find the user.');
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
                return;
            }
            
            // Allow muting all users with bot permissions (removed hierarchy check)
            
            // Voice mute the user (only microphone)
            await targetMember.voice.setMute(true, 'Wyciszenie mikrofonu przez bota TimerBot');
            
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Microphone Muted')
                .setDescription(`**${targetMember.user.username}** has been microphone-muted.\n\n*An admin/moderator can unmute.*`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true) });
            
        } catch (error) {
            console.error('Error muting user:', error);
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription('Failed to mute the user. Check bot permissions.')
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    
    else if (customId === 'unmute_user') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Check if user has moderator permissions
        if (!hasTimerBotUserRole(member)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Insufficient Permissions')
                .setDescription('You do not have permission to unmute users.\nRequired: Moderator or Administrator');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true), ephemeral: true });
            return;
        }
        
        // Get microphone history
        const history = getMicrophoneHistory(guild.id);
        if (history.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ No History')
                .setDescription('No users in microphone history to unmute.');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(false), ephemeral: true });
            return;
        }
        
        // Create user selection embed for unmuting
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🔊 Select User to Unmute')
            .setDescription('Choose a user from the list below:\n\n' + 
                history.map((entry, index) => 
                    `${index + 1}. **${entry.username}** - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
                ).join('\n') + 
                '\n\n**Note:** This unmute applies to the microphone.')
            .setTimestamp();
        
        // Create user selection buttons (max 5 users due to Discord limit)
        const maxUsers = Math.min(history.length, 5);
        const userButtons = [];
        
        for (let i = 0; i < maxUsers; i++) {
            const entry = history[i];
            userButtons.push(
                new ButtonBuilder()
                    .setCustomId(`unmute_user_${entry.userId}`)
                    .setLabel(`${i + 1}. ${entry.username}`)
                    .setStyle(ButtonStyle.Success)
            );
        }
        
        const row1 = new ActionRowBuilder().addComponents(...userButtons);
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_voice_history')
                    .setLabel('⬅️ Back to History')
                    .setStyle(ButtonStyle.Primary)
            );
        
        await interaction.reply({ embeds: [embed], components: [row1, row2] });
    }
    
    else if (customId.startsWith('unmute_user_')) {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Check if user has moderator permissions
        if (!hasTimerBotUserRole(member)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Insufficient Permissions')
                .setDescription('You do not have permission to unmute users.');
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
        
        const userId = customId.replace('unmute_user_', '');
        
        try {
            // Fetch the user to unmute
            const targetMember = await guild.members.fetch(userId);
            
            if (!targetMember) {
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Error')
                    .setDescription('Unable to find the user.');
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
                return;
            }
            
            // Allow unmuting all users with bot permissions (removed hierarchy check)
            
            // Unmute the user's microphone
        await targetMember.voice.setMute(false, 'Microphone unmute by TimerBot');
            
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Microphone Unmuted')
                .setDescription(`**${targetMember.user.username}** can use the microphone again.`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true) });
            
        } catch (error) {
            console.error('Error unmuting user:', error);
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription('Failed to unmute the user. Check bot permissions.')
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    
    else if (customId === 'back_to_voice_history') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const history = getMicrophoneHistory(guild.id);
        
        if (history.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#808080')
                .setTitle('🎤 Microphone History')
                .setDescription('No one has unmuted yet.');
            
            await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(false) });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('🎤 Last 10 Users Who Unmuted')
            .setDescription(history.map((entry, index) => 
                `${index + 1}. **${entry.username}** - <t:${Math.floor(entry.timestamp.getTime() / 1000)}:T>`
            ).join('\n'))
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], components: createMicrophoneHistoryButtons(true) });
    }
    
    else if (customId === 'clear_messages') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Show confirmation dialog
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('⚠️ Confirm Cleanup')
            .setDescription('Are you sure you want to clear the channel and microphone history?\n\n**This action cannot be undone!**')
            .addFields(
                {
                    name: 'What will be done:',
                    value: '• **Stop all active timers**\n• **Disconnect the bot from voice channel**\n• **Clear microphone history**\n• **Delete all bot messages**\n• **Attempt to delete user commands**\n• Timer messages\n• Button messages\n• Settings',
                    inline: false
                },
                {
                    name: 'What will be kept:',
                    value: '• **Pinned messages**\n• **Regular user messages (no !)**\n• **Commands !cs and !start (default)**\n• **User commands (if bot lacks permissions)**\n• Default timer settings',
                    inline: false
                }
            )
            .setFooter({ text: 'Created by amadosx 🍒' })
            .setTimestamp();
        
        const confirmRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_clear_messages')
                    .setLabel('🗑️ Yes, Clear Channel')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_clear_messages')
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await interaction.reply({ embeds: [embed], components: [confirmRow] });
    }
    
    else if (customId === 'confirm_clear_messages') {
        try {
            // Check if interaction is still valid
            if (interaction.replied || interaction.deferred) {
                return;
            }
            
            // Check if user has Timer Bot User role
            const member = await guild.members.fetch(interaction.user.id);
            if (!hasTimerBotUserRole(member)) {
                // Silently ignore users without permissions
                return;
            }
            
            // First, stop all active timers
            const stoppedTimers = [];
            for (const [channelId, timer] of activeTimers) {
                if (timer.guildId === guild.id) {
                    const timerInfo = stopTimer(channelId);
                    if (timerInfo) {
                        stoppedTimers.push(channelId);
                    }
                }
            }
            console.log(`Stopped ${stoppedTimers.length} timers before clearing messages`);
            
            // Then, disconnect bot from voice channel
            const left = leaveVoiceChannel(guild.id);
            if (left) {
                console.log('Bot disconnected from voice channel before clearing messages');
            }
            
            // Clear microphone history for this guild
            clearMicrophoneHistory(guild.id);
            console.log('Cleared microphone history for guild');
            
            // Get all messages in the channel (up to 100 for bulk delete)
            const messages = await channel.messages.fetch({ limit: 100 });
            let deletedCount = 0;
            
            console.log(`Found ${messages.size} messages to check`);
            
            // Separate messages into different categories
            const botMessagesToDelete = [];
            const userCommandsToDelete = [];
            const messagesToKeep = [];
            
            for (const message of messages.values()) {
                // Don't delete pinned messages
                if (message.pinned) {
                    console.log('Skipping pinned message');
                    messagesToKeep.push(message);
                    continue;
                }
                
                // Mark ALL other messages for deletion (both bot and user messages)
                if (message.author.id === client.user.id) {
                    console.log(`Marking bot message for deletion: "${message.content?.substring(0, 50)}..."`);
                    botMessagesToDelete.push(message);
                } else {
                    console.log(`Marking user message for deletion: "${message.content?.substring(0, 50)}..."`);
                    userCommandsToDelete.push(message);
                }
            }
            
            // Use bulk delete for bot messages (up to 100 at once)
            if (botMessagesToDelete.length > 0) {
                try {
                    const botMessageIds = botMessagesToDelete.map(m => m.id);
                    console.log(`Bulk deleting ${botMessageIds.length} bot messages...`);
                    await channel.bulkDelete(botMessageIds);
                    deletedCount += botMessageIds.length;
                } catch (error) {
                    console.log(`Bulk delete failed, falling back to individual deletion: ${error.message}`);
                    // Fallback to individual deletion
                    for (const message of botMessagesToDelete) {
                        try {
                            await message.delete();
                            deletedCount++;
                        } catch (deleteError) {
                            console.log(`Could not delete bot message: ${deleteError.message}`);
                        }
                    }
                }
            }
            
            // Try to delete user commands individually (bot might not have permission)
            for (const message of userCommandsToDelete) {
                try {
                    console.log(`Deleting user command: "${message.content}"`);
                    await message.delete();
                    deletedCount++;
                } catch (permError) {
                    console.log(`Cannot delete user message (missing permissions): "${message.content}"`);
                }
            }
            
            // Send a simple confirmation message that will be deleted after 2 seconds
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
            .setTitle('✅ Cleanup Complete')
            .setDescription(`Stopped ${stoppedTimers.length} timers, disconnected the bot, cleared microphone history, and deleted **${deletedCount}** messages.\n\nRemaining: only pinned/kept messages!`)
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            const confirmationMessage = await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
            
            // Delete the confirmation message after 2 seconds
            setTimeout(async () => {
                try {
                    if (confirmationMessage && !confirmationMessage.ephemeral) {
                        await confirmationMessage.delete();
                    }
                } catch (error) {
                    // Message might be already deleted
                }
            }, 2000);
            
        } catch (error) {
            // Check if interaction is still valid before replying
            if (!interaction.replied && !interaction.deferred) {
                try {
                    const embed = new EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('❌ Cleanup Error')
                        .setDescription('Failed to clear all messages. Please try again.')
                    
                    await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
                } catch (replyError) {
                    console.error('Error replying to interaction:', replyError.message);
                }
            }
        }
    }
    
    else if (customId === 'cancel_clear_messages') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#808080')
            .setTitle('❌ Cleanup Cancelled')
            .setDescription('Message cleanup has been cancelled.')
        
        await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
    }
    
    else if (customId === 'voice_join') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        // Use interaction.member for voice channel check
        const voiceMember = interaction.member;
        if (!voiceMember.voice.channel) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ You Are Not in a Voice Channel')
                .setDescription('You must be in a voice channel to connect the bot.');
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
        const connection = await joinVoiceChannelBot(guild, voiceMember.voice.channel);
        
        if (connection) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🔊 Bot Connected to Voice Channel')
                .setDescription(`Bot connected to: **${voiceMember.voice.channel.name}**`);
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Failed to Connect')
                .setDescription('Could not connect to the voice channel.');
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        }
    }
    
    else if (customId === 'voice_leave') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const left = leaveVoiceChannel(guild.id);
        
        if (left) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🔇 Bot Disconnected from Voice Channel')
                .setDescription('Bot has disconnected from the voice channel.');
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚠️ Bot Not in Voice Channel')
                .setDescription('The bot is not currently connected to a voice channel.')
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
        }
    }
    
    else if (customId === 'timer_help') {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('🔔 Timer Bot Commands')
            .setDescription('Discord bot with timers and voice notifications!')
            .addFields(
                {
                    name: '🎛️ Buttons (Recommended)',
                    value: '▶️ **Start Timer** - Start with default time\n⏹️ **Stop** - Stop the active timer\n🔗 **Connect to Voice** - Join the voice channel\n🔌 **Disconnect from Voice** - Leave the voice channel\n🎤 **Microphone History** - Show last 10 users\n🗑️ **Clear History** - Clear microphone history\n🧹 **Clear Channel** - Remove bot messages from channel\n⚙️ **Settings** - Set default time\n🚀 **Help** - Show this help',
                    inline: false
                },
                {
                    name: '🔔 Voice Notifications',
                    value: '🔔 Warning sound: 1 minute before the end\n🚨 Final alarm: when the timer ends\n\n**🚨 ⚠️ IMPORTANT ⚠️ 🚨**\n**The bot must be in a voice channel to play sounds!**\n**Press the "🔗 Connect to voice channel" button!**',
                    inline: false
                }
            )
            .setFooter({ text: 'Created by amadosx 🍒' })
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
    }
    
    
    // Quick timer buttons - set default time
    else if (customId.startsWith('quick_')) {
        // Check if interaction is still valid
        if (interaction.replied || interaction.deferred) return;
        
        // Check if user has Timer Bot User role
        const member = await guild.members.fetch(interaction.user.id);
        if (!hasTimerBotUserRole(member)) {
            // Silently ignore users without permissions
            return;
        }
        
        if (customId === 'quick_manual') {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚙️ Manual Time Setup')
                .setDescription('Use command: `!set cs [duration]`\n\n**Examples:**\n• `!set cs 2m` - 2 minutes\n• `!set cs 4m` - 4 minutes\n• `!set cs 5m` - 5 minutes\n• `!set cs 40m` - 40 minutes\n• `!set cs 30s` - 30 seconds\n• `!set cs 1h` - 1 hour')
                .setFooter({ text: 'Created by amadosx 🍒' })
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
            return;
        }
        
        const timeMap = {
            'quick_2m': '2m',
            'quick_4m': '4m',
            'quick_5m': '5m',
            'quick_6m': '6m',
            'quick_40m': '40m'
        };
        
        const timeStr = timeMap[customId];
        const duration = parseTime(timeStr, guild.id);
        
        if (duration === null) return;
        
        // Set as default time for this guild
        defaultTimes.set(guild.id, duration);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Default Time Set')
            .setDescription(`Default timer duration set to: **${formatTime(duration)}**\n\nNow you can use the "▶️ Start Timer" button or the \`!cs\` command without providing a duration.`)
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], components: [...createTimerButtons(), ...createQuickTimerButtons(false)] });
    }
    
    } catch (error) {
        console.error(`[INTERACTION ERROR] ${interaction.customId || interaction.commandName}:`, error.message);
        // Try to reply with error message if interaction is still valid
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ 
                    content: '❌ An error occurred while processing the command. Please try again.', 
                    ephemeral: true 
                });
                console.log(`[INTERACTION] Successfully replied with error message for ${interaction.customId || interaction.commandName}`);
            } catch (replyError) {
                console.error(`[INTERACTION FAILED] Could not reply to ${interaction.customId || interaction.commandName}:`, replyError.message);
            }
        } else {
            console.log(`[INTERACTION FAILED] ${interaction.customId || interaction.commandName} already replied/deferred - Discord will show "This interaction failed"`);
        }
    }
});

client.login(config.DISCORD_TOKEN);
