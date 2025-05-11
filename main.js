import { AgentProcess } from './src/process/agent_process.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createMindServer } from './src/server/mind_server.js';
import { mainProxy } from './src/process/main_proxy.js';
import { readFileSync } from 'fs';
import readline from 'readline';

// Map for quick bot/agent lookup by name
const agentsByName = new Map();

/**
 * Parse command line arguments using yargs.
 * Accepts:
 *   --profiles: Array of profile file paths
 *   --task_path: String path to task file
 *   --task_id: String id of the task
 */
function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}

/**
 * Determine which agent profile files to load.
 * Preference to CLI argument, fallback to settings.
 */
function getProfiles(args) {
    return args.profiles || settings.profiles || [];
}

/**
 * Main entrypoint.
 * - Optionally starts the mindserver if enabled in settings.
 * - Parses agent profiles.
 * - Loads and starts agents.
 * - Exposes minimal CLI for managing and interacting with agents ("bots").
 */
async function main() {
    // Start mind server, if configured
    if (settings.host_mindserver) {
        createMindServer(settings.mindserver_port);
    }

    // Connect main proxy (used for communication/registration)
    mainProxy.connect();

    // Parse command-line args and determine profiles to load
    const args = parseArguments();
    const profiles = getProfiles(args);

    if (!Array.isArray(profiles) || profiles.length === 0) {
        console.error('No agent profiles specified. Use --profiles or configure in settings.js');
        process.exit(1);
    }

    console.log('Loading agent profiles:', profiles);
    const { load_memory, init_message } = settings;

    // Load and start each agent process
    for (let i = 0; i < profiles.length; i++) {
        let agent_process = new AgentProcess();
        let profileData;
        try {
            profileData = readFileSync(profiles[i], 'utf8');
        } catch (err) {
            console.error(`Failed to read profile file "${profiles[i]}":`, err);
            continue;
        }

        let agent_json;
        try {
            agent_json = JSON.parse(profileData);
        } catch (err) {
            console.error(`Failed to parse JSON for profile "${profiles[i]}":`, err);
            continue;
        }

        // Register with main proxy and in agentsByName map for CLI access
        mainProxy.registerAgent(agent_json.name, agent_process);
        agentsByName.set(agent_json.name, agent_process);

        // Start the agent process
        try {
            agent_process.start(
                profiles[i],
                load_memory,
                init_message,
                i,
                args.task_path,
                args.task_id
            );
            // Allow some time for startup/registration
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`Failed to start agent "${agent_json.name}":`, err);
        }
    }

    // ==== COMMAND LINE INTERFACE ====
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    /**
     * Prints help information to stdout for CLI usage.
     */
    function printHelp() {
        console.log(`
Available commands:
--------------------
/help                        Show this help message
/list                        List all loaded bots
/say <bot> <message>         Make <bot> say <message> to other players
/exit                        Exit program
`);
    }

    printHelp();
    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed === '\n') {
            rl.prompt();
            return;
        }

        if (trimmed.startsWith('/help')) {
            printHelp();
        } else if (trimmed.startsWith('/list')) {
            if (agentsByName.size === 0) {
                console.log('No bots loaded.');
            } else {
                console.log('Loaded bots:', Array.from(agentsByName.keys()).join(', '));
            }
        } else if (trimmed.startsWith('/say')) {
            // Split into: '/say', botname, rest (message)
            const parts = trimmed.split(' ');
            if (parts.length < 3) {
                console.log('Usage: /say <bot> <message>');
            } else {
                const bot = parts[1];
                const msg = parts.slice(2).join(' ');
                if (!agentsByName.has(bot)) {
                    console.log(`Bot not found: ${bot}`);
                } else {
                    const agent = agentsByName.get(bot);
                    // Try to call appropriate method to make agent say something
                    if (typeof agent.sendMessageToPlayers === 'function') {
                        try {
                            await agent.sendMessageToPlayers(msg);
                            console.log(`Bot "${bot}" says to players: "${msg}"`);
                        } catch (err) {
                            console.error(`Failed to send message:`, err);
                        }
                    } else if (typeof agent.sendMessage === 'function') {
                        // Fallback if alternate method exists
                        try {
                            await agent.sendMessage(msg);
                            console.log(`Bot "${bot}" says: "${msg}"`);
                        } catch (err) {
                            console.error(`Failed to send message:`, err);
                        }
                    } else {
                        console.log(`Cannot send message: Agent process does not support .sendMessageToPlayers(msg)`);
                    }
                }
            }
        } else if (trimmed.startsWith('/exit')) {
            console.log('Exiting...');
            rl.close();
            // Optionally, you may want to clean up agent processes here
            process.exit(0);
        } else {
            console.log('Unknown command, type /help for options.');
        }
        rl.prompt();
    });

    rl.on('close', () => {
        console.log('CLI closed.');
        // Optional: clean up any running agent processes here
        process.exit(0);
    });
}

// Top-level run with error trapping
(async () => {
    try {
        await main();
    } catch (error) {
        console.error('An error occurred:', error);
        process.exit(1);
    }
})();
