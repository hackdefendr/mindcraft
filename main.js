import { AgentProcess } from './src/process/agent_process.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createMindServer } from './src/server/mind_server.js';
import { mainProxy } from './src/process/main_proxy.js';
import { readFileSync } from 'fs';
import readline from 'readline';
import './src/agent/commands/index.js';
import { actionsList as builtinCommands } from './src/agent/commands/actions.js';

const agentsByName = new Map();

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', { type: 'array', describe: 'List of agent profile paths' })
        .option('task_path', { type: 'string', describe: 'Path to task file to execute' })
        .option('task_id', { type: 'string', describe: 'Task ID to execute' })
        .help()
        .alias('help', 'h')
        .parse();
}
function getProfiles(args) {
    return args.profiles || settings.profiles || [];
}

/**
 * Convert an array of action objects ({name, handler, ...})
 * to a map { [name]: obj }
 * @param {Array|Object} actions
 */
function toCommandMap(actions) {
    if (!actions) return {};
    if (!Array.isArray(actions)) return { ...actions };
    const out = {};
    for (const obj of actions) {
        if (obj && obj.name) out[obj.name.toLowerCase()] = obj;
    }
    return out;
}

// ==== COMMAND HANDLER CONSTRUCTION ====

function buildCliCommands(agentsByName) {
    // Legacy or wrapper commands not in builtinCommands
    const cliLegacy = {};

    cliLegacy.help = {
        description: "Show this help message.",
        usage: "!help or !?",
        aliases: ["?", "h"],
        handler: (context) => {
            const allCommands = Object.entries(context.commands)
                .map(([name, cmd]) => {
                    let desc = cmd.description || "";
                    // Optionally show aliases
                    const aliasStr = cmd.aliases && cmd.aliases.length
                        ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
                    return `  ${name.padEnd(16)}${desc}${aliasStr}`;
                })
                .join('\n');
            console.log('Available commands:\n------------------\n' + allCommands);
        }
    };

    cliLegacy.exit = {
        description: "Exit the program.",
        usage: "!exit",
        aliases: ['quit'],
        handler: () => {
            console.log('Exiting...');
            process.exit(0);
        }
    };

    // ### CORRECTION: ALWAYS use toCommandMap!
    const builtins = toCommandMap(builtinCommands);

    // Optionally, override or extend builtins with CLI-specific commands
    return { ...builtins, ...cliLegacy };
}

function parseCommand(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('!')) return null;
    const [cmd, ...args] = trimmed.slice(1).split(' ');
    return { cmd: cmd.toLowerCase(), args };
}

/**
 * Try to resolve alias to real name.
 * Now case-insensitive!
 */
function resolveCommand(cmd, commands) {
    const arg = cmd.toLowerCase();
    for (const [name, obj] of Object.entries(commands)) {
        if (name === arg) return name;
        if (obj.aliases && obj.aliases.map(a => a.toLowerCase()).includes(arg)) return name;
    }
    return null;
}

// ==== MAIN ====

async function main() {
    if (settings.host_mindserver) {
        createMindServer(settings.mindserver_port);
    }
    mainProxy.connect();

    const args = parseArguments();
    const profiles = getProfiles(args);

    if (!Array.isArray(profiles) || profiles.length === 0) {
        console.error('No agent profiles specified. Use --profiles or configure in settings.js');
        process.exit(1);
    }

    console.log('Loading agent profiles:', profiles);

    const { load_memory, init_message } = settings;
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

        mainProxy.registerAgent(agent_json.name, agent_process);
        agentsByName.set(agent_json.name, agent_process);

        try {
            agent_process.start(
                profiles[i],
                load_memory,
                init_message,
                i,
                args.task_path,
                args.task_id
            );
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`Failed to start agent "${agent_json.name}":`, err);
        }
    }

    // ==== COMMAND LINE INTERFACE ====
    const commands = buildCliCommands(agentsByName);

    // Context passed to each command handler
    const context = {
        agentsByName,
        commands,
        mainProxy,
        settings
    };

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    // Auto-print help on start
    commands.help.handler(context);

    rl.prompt();

    rl.on('line', async (line) => {
        const cmdParsed = parseCommand(line);
        if (!cmdParsed) {
            rl.prompt();
            return;
        }
        const { cmd, args } = cmdParsed;
        const commandName = resolveCommand(cmd, commands);
        if (!commandName) {
            console.log('Unknown command, type !help for options.');
            rl.prompt();
            return;
        }
        try {
            const handler = commands[commandName].handler;
            if (!handler) throw new Error(`No handler for command "${commandName}"`);
            await Promise.resolve(handler(context, ...args));
        } catch (err) {
            console.error('Command error:', err);
        }
        rl.prompt();
    });

    rl.on('close', () => {
        console.log('CLI closed.');
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
