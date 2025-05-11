import { spawn } from 'child_process';
import { mainProxy } from './main_proxy.js';

export class AgentProcess {
    constructor(name) {
        this.name = name;
        this.profile = null;
        this.count_id = 0;
        this.running = false;
        this.process = null;
    }

    start(profile, load_memory = false, init_message = null, count_id = 0, task_path = null, task_id = null) {
        this.profile = profile;
        this.count_id = count_id;
        this.running = true;

        let args = ['src/process/init_agent.js', this.name];
        args.push('-p', profile);
        args.push('-c', count_id);
        if (load_memory) args.push('-l', String(load_memory));
        if (init_message) args.push('-m', init_message);
        if (task_path) args.push('-t', task_path);
        if (task_id) args.push('-i', task_id);

        const agentProcess = spawn('node', args, {
            stdio: 'inherit',
            stderr: 'inherit'
        });

        this.process = agentProcess;
        let last_restart = Date.now();

        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process (${this.name}) exited with code ${code} and signal ${signal}`);
            this.running = false;
            mainProxy.logoutAgent(this.name);

            // If exit code > 1, terminate main process
            if (typeof code === "number" && code > 1) {
                console.log('Ending task');
                process.exit(code);
            }

            // Restart if abnormal exit (and not via SIGINT)
            if (code !== 0 && signal !== 'SIGINT') {
                if (Date.now() - last_restart < 10000) {
                    console.error(`Agent process ${profile} exited too quickly and will not be restarted.`);
                    return;
                }
                console.log('Restarting agent...');
                last_restart = Date.now();
                // Recurse with restarted agent
                this.start(profile, true, 'Agent process restarted.', count_id, task_path, task_id);
            }
        });

        agentProcess.on('error', (err) => {
            console.error(`Agent process (${this.name}) error:`, err);
        });
    }

    stop() {
        if (!this.running || !this.process) return;
        try {
            this.process.kill('SIGINT');
        } catch (err) {
            console.error('Error stopping agent process:', err);
        }
        this.running = false;
    }

    async sendMessageToPlayers(msg) {
        // Real implementation would likely relay this to the child process,
        // frontend, or message queue. Placeholder implementation logs only.
        console.log(`Sending message to players: ${msg}`);
        // Optionally hook into IPC/send as needed here.
        return Promise.resolve();
    }

    continue() {
        // If not running, restart with previous state
        if (!this.running) {
            this.start(
                this.profile,
                true,
                'Agent process restarted.',
                this.count_id
                // Optionally: task_path, task_id can be refactored as properties and included
            );
        }
    }
}
