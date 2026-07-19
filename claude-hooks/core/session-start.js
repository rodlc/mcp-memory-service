/**
 * Claude Code Session Start Hook
 * Automatically injects relevant memories at the beginning of each session
 */

const fs = require('fs').promises;
const path = require('path');

// Import utilities
const { detectProjectContext } = require('../utilities/project-detector');
const { detectContextShift, extractCurrentContext } = require('../utilities/context-shift-detector');
const { MemoryClient } = require('../utilities/memory-client');
const { detectUserOverrides, logOverride } = require('../utilities/user-override-detector');

/**
 * Load hook configuration
 */
async function loadConfig() {
    try {
        const configPath = path.join(__dirname, '../config.json');
        const configData = await fs.readFile(configPath, 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.warn('[Memory Hook] Using default configuration:', error.message);
        return {
            memoryService: {
                protocol: 'auto',
                preferredProtocol: 'http',
                fallbackEnabled: true,
                http: {
                    endpoint: 'http://127.0.0.1:8889',
                    apiKey: 'test-key-123',
                    healthCheckTimeout: 3000,
                    useDetailedHealthCheck: false
                },
                mcp: {
                    serverCommand: ['uv', 'run', 'memory', 'server'],
                    serverWorkingDir: null,
                    connectionTimeout: 5000,
                    toolCallTimeout: 10000
                },
                defaultTags: ['claude-code', 'auto-generated'],
                maxMemoriesPerSession: 8,
                injectAfterCompacting: false
            },
            projectDetection: {
                gitRepository: true,
                packageFiles: ['package.json', 'pyproject.toml', 'Cargo.toml'],
                frameworkDetection: true,
                languageDetection: true
            },
            output: {
                verbose: true, // Default to verbose for backward compatibility
                showMemoryDetails: false, // Hide detailed memory scoring by default
                showProjectDetails: true, // Show project detection by default
                showScoringDetails: false, // Hide detailed scoring breakdown
                cleanMode: false // Default to normal output
            }
        };
    }
}

/**
 * Query memory service for health information (supports both HTTP and MCP)
 */
async function queryMemoryHealth(memoryClient) {
    try {
        const healthResult = await memoryClient.getHealthStatus();
        return healthResult;
    } catch (error) {
        return {
            success: false,
            error: error.message,
            fallback: true
        };
    }
}

/**
 * Parse health data into storage info structure (supports both HTTP and MCP responses)
 */
function parseHealthDataToStorageInfo(healthData) {
    try {
        // Handle MCP tool response format
        if (healthData.content && Array.isArray(healthData.content)) {
            const textContent = healthData.content.find(c => c.type === 'text')?.text;
            if (textContent) {
                try {
                    // Parse JSON from MCP response
                    const parsedData = JSON.parse(textContent.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null'));
                    return parseHealthDataToStorageInfo(parsedData);
                } catch (parseError) {
                    console.warn('[Memory Hook] Could not parse MCP health response:', parseError.message);
                    return getUnknownStorageInfo();
                }
            }
        }

        // Handle direct health data object
        const storage = healthData.storage || healthData || {};
        const system = healthData.system || {};
        const statistics = healthData.statistics || healthData.stats || {};
        
        // Determine icon based on backend
        let icon = '💾';
        switch (storage.backend?.toLowerCase()) {
            case 'sqlite-vec':
            case 'sqlite_vec':
                icon = '🪶';
                break;
            case 'chromadb':
            case 'chroma':
                icon = '📦';
                break;
            case 'cloudflare':
                icon = '☁️';
                break;
        }
        
        // Build description with status
        const backendName = storage.backend ? storage.backend.replace('_', '-') : 'Unknown';
        const statusText = storage.status === 'connected' ? 'Connected' : 
                          storage.status === 'disconnected' ? 'Disconnected' : 
                          storage.status || 'Unknown';
        
        const description = `${backendName} (${statusText})`;
        
        // Build location info (use cwd as better fallback than "Unknown")
        let location = storage.database_path || storage.location || process.cwd();
        if (location.length > 50) {
            location = '...' + location.substring(location.length - 47);
        }
        
        // Determine type (local/remote/cloud)
        let type = 'unknown';
        if (storage.backend === 'cloudflare') {
            type = 'cloud';
        } else if (storage.database_path && storage.database_path.startsWith('/')) {
            type = 'local';
        } else if (location.includes('://')) {
            type = 'remote';
        } else {
            type = 'local';
        }
        
        return {
            backend: storage.backend || 'unknown',
            type: type,
            location: location,
            description: description,
            icon: icon,
            // Rich health data
            health: {
                status: storage.status,
                totalMemories: statistics.total_memories || storage.total_memories || 0,
                databaseSizeMB: statistics.database_size_mb || storage.database_size_mb || 0,
                uniqueTags: statistics.unique_tags || storage.unique_tags || 0,
                embeddingModel: storage.embedding_model || 'Unknown',
                platform: system.platform,
                uptime: healthData.uptime_seconds,
                accessible: storage.accessible
            }
        };
        
    } catch (error) {
        return getUnknownStorageInfo();
    }
}

/**
 * Get unknown storage info structure
 */
function getUnknownStorageInfo() {
    return {
        backend: 'unknown',
        type: 'unknown',
        location: 'Health parse error',
        description: 'Unknown Storage',
        icon: '❓',
        health: { status: 'error', totalMemories: 0 }
    };
}

/**
 * Detect storage backend configuration (fallback method)
 */
function detectStorageBackendFallback(config) {
    try {
        // Check environment variable first
        const envBackend = process.env.MCP_MEMORY_STORAGE_BACKEND?.toLowerCase();
        const endpoint = config.memoryService?.http?.endpoint || 'http://127.0.0.1:8889';
        
        // Parse endpoint to determine if local or remote
        const url = new URL(endpoint);
        const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.local');
        
        let storageInfo = {
            backend: 'unknown',
            type: 'unknown',
            location: endpoint,
            description: 'Unknown Storage',
            icon: '💾',
            health: { status: 'unknown', totalMemories: 0 }
        };
        
        if (envBackend) {
            switch (envBackend) {
                case 'sqlite_vec':
                    storageInfo = {
                        backend: 'sqlite_vec',
                        type: 'local',
                        location: process.env.MCP_MEMORY_SQLITE_PATH || '~/.mcp-memory/memories.db',
                        description: 'SQLite-vec (Config)',
                        icon: '🪶',
                        health: { status: 'unknown', totalMemories: 0 }
                    };
                    break;
                    
                case 'chromadb':
                case 'chroma':
                    const chromaHost = process.env.MCP_MEMORY_CHROMADB_HOST;
                    const chromaPath = process.env.MCP_MEMORY_CHROMA_PATH;
                    
                    if (chromaHost) {
                        // Remote ChromaDB
                        const chromaPort = process.env.MCP_MEMORY_CHROMADB_PORT || '8000';
                        const ssl = process.env.MCP_MEMORY_CHROMADB_SSL === 'true';
                        const protocol = ssl ? 'https' : 'http';
                        storageInfo = {
                            backend: 'chromadb',
                            type: 'remote',
                            location: `${protocol}://${chromaHost}:${chromaPort}`,
                            description: 'ChromaDB (Remote Config)',
                            icon: '🌐',
                            health: { status: 'unknown', totalMemories: 0 }
                        };
                    } else {
                        // Local ChromaDB
                        storageInfo = {
                            backend: 'chromadb',
                            type: 'local',
                            location: chromaPath || '~/.mcp-memory/chroma',
                            description: 'ChromaDB (Config)',
                            icon: '📦',
                            health: { status: 'unknown', totalMemories: 0 }
                        };
                    }
                    break;
                    
                case 'cloudflare':
                    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
                    storageInfo = {
                        backend: 'cloudflare',
                        type: 'cloud',
                        location: accountId ? `Account: ${accountId.substring(0, 8)}...` : 'Cloudflare Workers',
                        description: 'Cloudflare Vector (Config)',
                        icon: '☁️',
                        health: { status: 'unknown', totalMemories: 0 }
                    };
                    break;
            }
        } else {
            // Fallback: infer from endpoint
            if (isLocal) {
                storageInfo = {
                    backend: 'local_service',
                    type: 'local',
                    location: endpoint,
                    description: 'Local MCP Service',
                    icon: '💾',
                    health: { status: 'unknown', totalMemories: 0 }
                };
            } else {
                storageInfo = {
                    backend: 'remote_service',
                    type: 'remote',
                    location: endpoint,
                    description: 'Remote MCP Service',
                    icon: '🌐',
                    health: { status: 'unknown', totalMemories: 0 }
                };
            }
        }
        
        return storageInfo;
        
    } catch (error) {
        return {
            backend: 'unknown',
            type: 'unknown',
            location: 'Configuration Error',
            description: 'Unknown Storage',
            icon: '❓',
            health: { status: 'error', totalMemories: 0 }
        };
    }
}


// ANSI Colors for console output
const CONSOLE_COLORS = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',
    CYAN: '\x1b[36m',
    GREEN: '\x1b[32m',
    BLUE: '\x1b[34m',
    YELLOW: '\x1b[33m',
    GRAY: '\x1b[90m',
    RED: '\x1b[31m'
};

/**
 * Main session start hook function with enhanced visual output
 */
async function onSessionStart(context) {
    // Global timeout wrapper to prevent hook from hanging
    // Config specifies 10s, we use 9.5s to leave 0.5s buffer for cleanup
    // With 1 git query + 1 recent query, expect ~9.5s total (4.5s each due to Python cold-start)
    const HOOK_TIMEOUT = 9500; // 9.5 seconds
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Hook timeout - completing early')), HOOK_TIMEOUT);
    });

    try {
        return await Promise.race([
            executeSessionStart(context),
            timeoutPromise
        ]);
    } catch (error) {
        if (error.message.includes('Hook timeout')) {
            console.log(`${CONSOLE_COLORS.YELLOW}⏱️  Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}Completed with timeout (normal for slow connections)${CONSOLE_COLORS.RESET}`);
            return;
        }
        throw error;
    }
}

/**
 * Main execution logic (wrapped by timeout)
 */
async function executeSessionStart(context) {
    try {
        // Load configuration first to check verbosity settings
        const config = await loadConfig();
        const verbose = config.output?.verbose !== false; // Default to true
        const cleanMode = config.output?.cleanMode === true; // Default to false
        const showMemoryDetails = config.output?.showMemoryDetails === true;
        const showProjectDetails = config.output?.showProjectDetails !== false; // Default to true

        // Check for user overrides (#skip / #remember)
        const overrides = detectUserOverrides(context.userMessage);
        if (overrides.forceSkip) {
            logOverride('skip');
            return;
        }
        // Note: forceRemember for session-start could force retrieval even without context shift
        // Currently we just log and continue - could be enhanced later
        if (overrides.forceRemember && verbose && !cleanMode) {
            console.log(`${CONSOLE_COLORS.CYAN}💾 Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Force retrieval requested (#remember)`);
        }

        if (verbose && !cleanMode) {
            console.log(`${CONSOLE_COLORS.CYAN}🧠 Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Initializing session awareness...`);
        }

        // Check if this is triggered by a compacting event and skip if configured to do so
        if (context.trigger === 'compacting' || context.event === 'memory-compacted') {
            if (!config.memoryService.injectAfterCompacting) {
                console.log(`${CONSOLE_COLORS.YELLOW}⏸️  Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Skipping injection after compacting`);
                return;
            }
            console.log(`${CONSOLE_COLORS.GREEN}▶️  Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Proceeding with injection after compacting`);
        }
        
        // For non-session-start events, use smart timing to decide if refresh is needed
        if (context.trigger !== 'session-start' && context.trigger !== 'start') {
            const currentContext = extractCurrentContext(context.conversationState || {}, context.workingDirectory);
            const previousContext = context.previousContext || context.conversationState?.previousContext;
            
            if (previousContext) {
                const shiftDetection = detectContextShift(currentContext, previousContext);
                
                if (!shiftDetection.shouldRefresh) {
                    console.log(`${CONSOLE_COLORS.GRAY}⏸️  Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}No context shift detected, skipping${CONSOLE_COLORS.RESET}`);
                    return;
                }
                
                console.log(`${CONSOLE_COLORS.BLUE}🔄 Memory Hook${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Context shift: ${shiftDetection.description}`);
            }
        }
        
        // Detect project context
        const projectContext = await detectProjectContext(context.workingDirectory || process.cwd());
        if (verbose && showProjectDetails && !cleanMode) {
            const projectDisplay = `${CONSOLE_COLORS.BRIGHT}${projectContext.name}${CONSOLE_COLORS.RESET}`;
            const typeDisplay = projectContext.language !== 'Unknown' ? ` ${CONSOLE_COLORS.GRAY}(${projectContext.language})${CONSOLE_COLORS.RESET}` : '';
            console.log(`${CONSOLE_COLORS.BLUE}📂 Project Detector${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Analyzing ${projectDisplay}${typeDisplay}`);
        }
        
        // Initialize memory client and detect storage backend
        const showStorageSource = config.memoryService?.showStorageSource !== false; // Default to true
        const sourceDisplayMode = config.memoryService?.sourceDisplayMode || 'brief';
        let memoryClient = null;
        let storageInfo = null;
        let connectionInfo = null;

        if (showStorageSource && verbose && !cleanMode) {
            // Initialize unified memory client for health check and memory queries
            try {
                memoryClient = new MemoryClient(config.memoryService);
                const connection = await memoryClient.connect();
                connectionInfo = memoryClient.getConnectionInfo();

                if (verbose && showMemoryDetails && !cleanMode && connectionInfo?.activeProtocol) {
                    console.log(`${CONSOLE_COLORS.CYAN}🔗 Connection${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} Using ${CONSOLE_COLORS.BRIGHT}${connectionInfo.activeProtocol.toUpperCase()}${CONSOLE_COLORS.RESET} protocol`);
                }

                const healthResult = await queryMemoryHealth(memoryClient);
                
                    if (healthResult.success) {
                        storageInfo = parseHealthDataToStorageInfo(healthResult.data);

                        // Display based on mode with rich health information
                        if (sourceDisplayMode === 'detailed') {
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${CONSOLE_COLORS.BRIGHT}${storageInfo.description}${CONSOLE_COLORS.RESET}`);
                            console.log(`${CONSOLE_COLORS.CYAN}📍 Location${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}${storageInfo.location}${CONSOLE_COLORS.RESET}`);
                            if (storageInfo.health.totalMemories > 0) {
                                console.log(`${CONSOLE_COLORS.CYAN}📊 Database${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GREEN}${storageInfo.health.totalMemories} memories${CONSOLE_COLORS.RESET}, ${CONSOLE_COLORS.YELLOW}${storageInfo.health.databaseSizeMB}MB${CONSOLE_COLORS.RESET}, ${CONSOLE_COLORS.BLUE}${storageInfo.health.uniqueTags} tags${CONSOLE_COLORS.RESET}`);
                            }
                        } else if (sourceDisplayMode === 'brief') {
                            const memoryCount = storageInfo.health.totalMemories > 0 ? ` • ${storageInfo.health.totalMemories} memories` : '';
                            const sizeInfo = storageInfo.health.databaseSizeMB > 0 ? ` • ${storageInfo.health.databaseSizeMB}MB` : '';
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${CONSOLE_COLORS.BRIGHT}${storageInfo.description}${CONSOLE_COLORS.RESET}${memoryCount}${sizeInfo}`);
                            if (storageInfo.location && sourceDisplayMode === 'brief') {
                                console.log(`${CONSOLE_COLORS.CYAN}📍 Path${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}${storageInfo.location}${CONSOLE_COLORS.RESET}`);
                            }
                        } else if (sourceDisplayMode === 'icon-only') {
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${storageInfo.backend} • ${storageInfo.health.totalMemories} memories`);
                        }
                    } else {
                        // Fallback to environment/config detection when MCP health check fails
                        if (verbose && showMemoryDetails && !cleanMode) {
                            console.log(`${CONSOLE_COLORS.YELLOW}⚠️  MCP Health Check${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}${healthResult.error}, using config fallback${CONSOLE_COLORS.RESET}`);
                        }

                        storageInfo = detectStorageBackendFallback(config);

                        if (sourceDisplayMode === 'detailed') {
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${CONSOLE_COLORS.BRIGHT}${storageInfo.description}${CONSOLE_COLORS.RESET}`);
                            console.log(`${CONSOLE_COLORS.CYAN}📍 Location${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}${storageInfo.location}${CONSOLE_COLORS.RESET}`);
                        } else if (sourceDisplayMode === 'brief') {
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${CONSOLE_COLORS.BRIGHT}${storageInfo.description}${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}(${storageInfo.location})${CONSOLE_COLORS.RESET}`);
                        } else if (sourceDisplayMode === 'icon-only') {
                            console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${storageInfo.backend}`);
                        }
                    }
            } catch (error) {
                // Memory client connection failed, fall back to environment detection
                if (verbose && showMemoryDetails && !cleanMode) {
                    console.log(`${CONSOLE_COLORS.YELLOW}⚠️  Memory Connection${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}${error.message}, using environment fallback${CONSOLE_COLORS.RESET}`);
                }

                storageInfo = detectStorageBackendFallback(config);

                if (sourceDisplayMode === 'brief') {
                    console.log(`${CONSOLE_COLORS.CYAN}💾 Storage${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${storageInfo.icon} ${CONSOLE_COLORS.BRIGHT}${storageInfo.description}${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.GRAY}(${storageInfo.location})${CONSOLE_COLORS.RESET}`);
                }
            }
        } else {
            storageInfo = detectStorageBackendFallback(config);
        }

        // Worktree detection — contextual info for Claude
        try {
            const { execSync } = require('child_process');
            const cwd = context.workingDirectory || process.cwd();
            const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8', cwd }).trim();
            const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', cwd }).trim();
            const resolvedCommonDir = require('path').resolve(cwd, gitCommonDir);
            const repoName = require('path').dirname(resolvedCommonDir).split('/').pop();
            if (!['workspace', 'dotfiles'].includes(repoName)) {
                if (gitDir === gitCommonDir) {
                    const branch = execSync('git symbolic-ref --short HEAD', { encoding: 'utf8', cwd }).trim();
                    console.log(`\n⚠ NOT in a worktree on ${repoName} (branch: ${branch}). Call EnterWorktree before any edits.`);
                } else {
                    const branch = execSync('git symbolic-ref --short HEAD', { encoding: 'utf8', cwd }).trim();
                    const lastCommit = execSync('git log -1 --format="%cr"', { encoding: 'utf8', cwd }).trim();
                    const wtName = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd }).trim().split('/').pop();
                    let portInfo = '';
                    try {
                        const port = require('fs').readFileSync(require('path').join(cwd, '.port'), 'utf8').trim();
                        portInfo = `, port: ${port}`;
                    } catch (e) { /* no .port file — silent */ }

                    if (branch.startsWith('worktree-')) {
                        console.log(`\n📍 Worktree '${wtName}' on ${repoName} — landing branch (branch: ${branch}). Create a task branch: git checkout -b feat-xxx`);
                    } else {
                        let isMerged = false;
                        try {
                            const track = execSync(`git for-each-ref --format="%(upstream:track)" "refs/heads/${branch}"`, { encoding: 'utf8', cwd }).trim();
                            isMerged = track === '[gone]';
                        } catch (e) { /* no upstream tracking info available */ }

                        if (isMerged) {
                            console.log(`\n📍 Worktree '${wtName}' on ${repoName} — branch merged (branch: ${branch}). Create a new task branch: git checkout -b feat-xxx`);
                        } else {
                            console.log(`\n📍 Worktree '${wtName}' on ${repoName} (branch: ${branch}, last commit: ${lastCommit}${portInfo}). New task? → EnterWorktree.`);
                        }
                    }
                }
            }
        } catch (e) { /* not a git repo or git unavailable */ }

    } catch (error) {
        console.error(`${CONSOLE_COLORS.RED}❌ Memory Hook Error${CONSOLE_COLORS.RESET} ${CONSOLE_COLORS.DIM}→${CONSOLE_COLORS.RESET} ${error.message}`);
        // Fail gracefully - don't prevent session from starting
    } finally {
        // Ensure MCP client cleanup even on error
        try {
            if (memoryClient && typeof memoryClient.disconnect === 'function') {
                await memoryClient.disconnect();
            }
        } catch (error) {
            // Ignore cleanup errors silently
        }
    }
}

/**
 * Hook metadata for Claude Code
 */
module.exports = {
    name: 'memory-awareness-session-start',
    version: '2.3.0',
    description: 'Automatically inject relevant memories at session start with git-aware repository context',
    trigger: 'session-start',
    handler: onSessionStart,
    config: {
        async: true,
        timeout: 15000, // Increased timeout for git analysis
        priority: 'high'
    }
};

// Direct execution support for testing
if (require.main === module) {
    // Test the hook with mock context
    const mockContext = {
        workingDirectory: process.cwd(),
        sessionId: 'test-session',
        injectSystemMessage: async (message) => {
            // Just print the message - it already has its own formatting from context-formatter.js
            console.log(message);
        }
    };
    
    onSessionStart(mockContext)
        .then(() => {
            // Test completed quietly
            process.exit(0);
        })
        .catch(error => {
            console.error(`${CONSOLE_COLORS.RED}❌ Hook test failed:${CONSOLE_COLORS.RESET} ${error.message}`);
            process.exit(1);
        });
}