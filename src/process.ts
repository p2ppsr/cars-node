import { spawn, type StdioOptions } from 'node:child_process';

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  maxOutputBytes?: number;
  stdio?: StdioOptions;
  timeoutMs?: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const rendered = [command, ...args].join(' ');
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      const value = Buffer.from(chunk);
      outputBytes += value.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`Command output exceeded ${maxOutputBytes} bytes: ${rendered}`));
        return;
      }
      target.push(value);
    };

    child.stdout?.on('data', chunk => collect(stdout, chunk));
    child.stderr?.on('data', chunk => collect(stderr, chunk));
    child.once('error', error => fail(new Error(`Unable to start ${command}: ${error.message}`)));

    const timeout = options.timeoutMs
      ? setTimeout(() => fail(new Error(`Command timed out after ${options.timeoutMs}ms: ${rendered}`)), options.timeoutMs)
      : undefined;

    child.once('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(
        `Command failed (${rendered}): ${signal ? `signal ${signal}` : `exit ${code}`}${detail ? `: ${detail.slice(0, 2000)}` : ''}`,
      ));
    });

    if (child.stdin) {
      if (options.input != null) child.stdin.end(options.input);
      else child.stdin.end();
    }
  });
}
