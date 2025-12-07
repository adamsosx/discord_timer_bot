#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Cleanup old log files older than 5 days
 */
function cleanupOldLogs() {
    const logsDir = path.join(__dirname, '..', 'logs');
    
    if (!fs.existsSync(logsDir)) {
        console.log('Logs directory does not exist');
        return;
    }
    
    const files = fs.readdirSync(logsDir);
    const now = Date.now();
    const fiveDaysAgo = now - (5 * 24 * 60 * 60 * 1000);
    let deletedCount = 0;
    
    files.forEach(file => {
        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);
        
        // Delete files older than 5 days
        if (stats.mtime.getTime() < fiveDaysAgo) {
            try {
                fs.unlinkSync(filePath);
                console.log(`Deleted old log file: ${file}`);
                deletedCount++;
            } catch (error) {
                console.error(`Error deleting ${file}:`, error.message);
            }
        }
    });
    
    console.log(`Cleanup completed. Deleted ${deletedCount} old log files.`);
}

// Run cleanup
cleanupOldLogs();
