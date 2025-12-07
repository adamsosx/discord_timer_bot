require('dotenv').config();

// Bot configuration constants
const BOT_CONFIG = {
    // Timer settings
    DEFAULT_TIMER_DURATION: 5 * 60 * 1000, // 5 minutes
    MIN_TIMER_DURATION: 1000, // 1 second
    MAX_TIMER_DURATION: 24 * 60 * 60 * 1000, // 24 hours
    WARNING_TIME_BEFORE_END: 60 * 1000, // 1 minute
    
    // Update intervals
    TIMER_UPDATE_INTERVAL: 1000, // 1 second
    CLEANUP_INTERVAL: 10 * 60 * 1000, // 10 minutes
    
    // Message update settings
    MESSAGE_EDIT_TIMEOUT: 5000, // 5 seconds
    MESSAGE_FETCH_TIMEOUT: 3000, // 3 seconds
    
    // Rate limiting
    RATE_LIMIT_MS: 1000, // 1 second
    
    // Voice settings
    VOICE_CONNECTION_TIMEOUT: 30 * 1000, // 30 seconds
    VOICE_DISCONNECT_DELAY: 2000, // 2 seconds
    
    // History settings
    MAX_MICROPHONE_HISTORY: 10,
    MAX_MESSAGE_HISTORY: 50,
    
    // File paths
    SOUNDS_DIR: 'sounds',
    WARNING_SOUND: 'cri.mp3',
    END_SOUND: 'end.mp3',
    
    // Discord limits
    MAX_EMBED_DESCRIPTION_LENGTH: 4096,
    MAX_BUTTONS_PER_ROW: 5,
    MAX_ROWS_PER_MESSAGE: 5
};

// Error handling configuration
const ERROR_CONFIG = {
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000, // 1 second
    TIMEOUT_MS: 10000, // 10 seconds
    LOG_ERRORS: true
};

// Configuration validation
class ConfigValidator {
    static validate() {
        const errors = [];
        const warnings = [];
        
        // Check required environment variables
        if (!process.env.DISCORD_TOKEN) {
            errors.push('DISCORD_TOKEN is required');
        }
        
        if (!process.env.CLIENT_ID) {
            errors.push('CLIENT_ID is required');
        }
        
        // Validate token format (basic check)
        if (process.env.DISCORD_TOKEN && !process.env.DISCORD_TOKEN.match(/^[A-Za-z0-9._-]+$/)) {
            warnings.push('DISCORD_TOKEN format may be invalid');
        }
        
        // Validate client ID format
        if (process.env.CLIENT_ID && !process.env.CLIENT_ID.match(/^\d+$/)) {
            warnings.push('CLIENT_ID should be a numeric Discord application ID');
        }
        
        // Check if sounds directory exists
        const fs = require('fs');
        const path = require('path');
        const soundsDir = path.join(__dirname, BOT_CONFIG.SOUNDS_DIR);
        if (!fs.existsSync(soundsDir)) {
            errors.push(`Sounds directory not found: ${soundsDir}`);
        } else {
            // Check if sound files exist
            const warningSound = path.join(soundsDir, BOT_CONFIG.WARNING_SOUND);
            const endSound = path.join(soundsDir, BOT_CONFIG.END_SOUND);
            
            if (!fs.existsSync(warningSound)) {
                warnings.push(`Warning sound file not found: ${BOT_CONFIG.WARNING_SOUND}`);
            }
            
            if (!fs.existsSync(endSound)) {
                warnings.push(`End sound file not found: ${BOT_CONFIG.END_SOUND}`);
            }
        }
        
        // Log warnings
        if (warnings.length > 0) {
            console.warn('[CONFIG WARNINGS]:');
            warnings.forEach(warning => console.warn(`  - ${warning}`));
        }
        
        // Log errors and exit if critical
        if (errors.length > 0) {
            console.error('[CONFIG ERRORS]:');
            errors.forEach(error => console.error(`  - ${error}`));
            console.error('\nBot cannot start with invalid configuration!');
            process.exit(1);
        }
        
        console.log('[CONFIG] Configuration validation passed');
        return true;
    }
    
    static getConfig() {
        return {
            // Discord settings with fallbacks
            DISCORD_TOKEN: process.env.DISCORD_TOKEN || null,
            CLIENT_ID: process.env.CLIENT_ID || null,
            GUILD_ID: process.env.GUILD_ID || null,
            
            // Bot settings with fallbacks
            DEFAULT_TIMER_DURATION: parseInt(process.env.DEFAULT_TIMER_DURATION) || BOT_CONFIG.DEFAULT_TIMER_DURATION,
            RATE_LIMIT_MS: parseInt(process.env.RATE_LIMIT_MS) || BOT_CONFIG.RATE_LIMIT_MS,
            MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || ERROR_CONFIG.MAX_RETRIES,
            LOG_LEVEL: process.env.LOG_LEVEL || 'info',
            
            // Feature flags with fallbacks
            ENABLE_VOICE_NOTIFICATIONS: process.env.ENABLE_VOICE_NOTIFICATIONS !== 'false',
            ENABLE_MICROPHONE_HISTORY: process.env.ENABLE_MICROPHONE_HISTORY !== 'false',
            ENABLE_AUTO_CLEANUP: process.env.ENABLE_AUTO_CLEANUP !== 'false',
            
            // Debug settings
            DEBUG_MODE: process.env.DEBUG_MODE === 'true',
            VERBOSE_LOGGING: process.env.VERBOSE_LOGGING === 'true'
        };
    }
}

// Get validated configuration with fallbacks
const config = ConfigValidator.getConfig();

module.exports = {
    // Discord settings
    DISCORD_TOKEN: config.DISCORD_TOKEN,
    CLIENT_ID: config.CLIENT_ID,
    GUILD_ID: config.GUILD_ID,
    
    // Bot settings
    DEFAULT_TIMER_DURATION: config.DEFAULT_TIMER_DURATION,
    RATE_LIMIT_MS: config.RATE_LIMIT_MS,
    MAX_RETRIES: config.MAX_RETRIES,
    LOG_LEVEL: config.LOG_LEVEL,
    
    // Feature flags
    ENABLE_VOICE_NOTIFICATIONS: config.ENABLE_VOICE_NOTIFICATIONS,
    ENABLE_MICROPHONE_HISTORY: config.ENABLE_MICROPHONE_HISTORY,
    ENABLE_AUTO_CLEANUP: config.ENABLE_AUTO_CLEANUP,
    
    // Debug settings
    DEBUG_MODE: config.DEBUG_MODE,
    VERBOSE_LOGGING: config.VERBOSE_LOGGING,
    
    // Bot constants
    BOT_CONFIG: BOT_CONFIG,
    
    // Export classes
    ConfigValidator: ConfigValidator
};
