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

// ==== COMMAND HANDLER CONSTRUCTION ====

function buildCliCommands(agentsByName) {
    // Legacy or wrapper commands not in builtinCommands
    const cliLegacy = {};

    // HELP command: Show all commands and their descriptions
    cliLegacy.help = {
        description: "Show this help message.",
        usage: "!help or !?",
        aliases: ["?", "h"],
        handler: (context) => {
            const allCommands = Object.entries(context.commands)
                .map(([name, cmd]) => {
                    let desc = cmd.description || "";
                    // Optional: show aliases
                    // let aliasStr = cmd.aliases && cmd.aliases.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
                    return `  ${name.padEnd(16)}${desc}`;
                })
                .join('\n');
            console.log('Available commands:\n------------------\n' + allCommands);
        }
    };

    cliLegacy.exit = {
        description: "Exit the program.",
        usage: "!exit",
        aliases: ['quit'],
        handler: (ctx) => {
            console.log('Exiting...');
            process.exit(0);
        }
    };

    // Make sure builtinCommands is an object: { actionName: commandObj, ... }
    // If it's an array, convert it:
    let builtins = builtinCommands;
    if (Array.isArray(builtinCommands)) {
        // If actionsList was "export const actionsList = [ { name, handler, ... }, ... ]"
        // Convert to object { [name]: obj, ... }
        builtins = {};
        for (const obj of builtinCommands) {
            if (obj && obj.name) builtins[obj.name] = obj;
        }
    }

    // Optionally, you can merge/override any commands.
    return { ...builtins, ...cliLegacy };
}

// Parse input for command and args
function parseCommand(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('!')) return null;
    const [cmd, ...args] = trimmed.slice(1).split(' ');
    return { cmd: cmd.toLowerCase(), args };
}

// Try to resolve alias to real name
function resolveCommand(cmd, commands) {
    for (const [name, obj] of Object.entries(commands)) {
        if (name === cmd) return name;
        if (obj.aliases && obj.aliases.includes(cmd)) return name;
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
        // Call handler, pass context and args
        try {
            // Support async or sync handlers
            await Promise.resolve(commands[commandName].handler(context, ...args));
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
