import fs from 'node:fs/promises';
import path from 'node:path';
import {gitReadCommand} from './git-read-policy.js';
import {resolveExecutable} from './process.js';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonical(target: string): Promise<string> {
  try { return await fs.realpath(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonical(parent), path.basename(target));
  }
}
export class Policy {
  constructor(readonly cwd: string, readonly writable: boolean, readonly allowedPaths: string[] = [cwd]) {}
  async checkPath(input: string, write = false): Promise<string> {
    if (!input || input.includes('\0') || /[<>|?*]/.test(input)) throw Error('Invalid filesystem path');
    const resolved = path.resolve(this.cwd, input);
    if (resolved.slice(path.parse(resolved).root.length).includes(':')) throw Error('Alternate data streams are not allowed');
    const real = await canonical(resolved);
    if (!within(this.cwd, real)) throw Error('Path is outside the workspace');
    const relativeParts=path.relative(this.cwd,real).split(path.sep);
    if(relativeParts.some(p=>/^(\.env(?:\..*)?|\.ssh|\.aws|\.azure|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(p))) throw Error('Credential paths are not exposed to the agent');
    if (write) {
      if (!this.writable) throw Error('Read-only tool cannot write');
      const parts = path.relative(this.cwd, real).split(path.sep);
      if (parts.some(p => /^(\.git|\.grok|\.codex|\.agents|\.ssh|\.aws|\.azure|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(p))) throw Error('Credential/configuration path changes require parent approval');
      if (!this.allowedPaths.some(p => within(p, real))) throw Error('Path is outside allowed_paths');
    }
    return real;
  }
  async command(command: string): Promise<{command: string; args: string[]}> {
    if (/^git(?:\.exe)?(?:\s|$)/i.test(command.trim())) return (await gitReadCommand(command,p=>this.checkPath(p)))!;
    if (!this.writable) throw Error('Read-only tools only support approved Git queries');
    const match = /^node(?:\.exe)? --check (?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))$/.exec(command.trim());
    if (!match) {
      if(!command.trim()||command.includes('\0'))throw Error('Invalid shell command');
      return process.platform==='win32'
        ? {command:await resolveExecutable(undefined,['pwsh.exe'])??path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-Command',command]}
        : {command:'/bin/bash',args:['-lc',command]};
    }
    const target = await this.checkPath(match[1] || match[2] || match[3]);
    return {command:process.execPath, args:['--check',target]};
  }
  async permission(call: ToolCallUpdate): Promise<void> {
    const input = (call.rawInput ?? {}) as Record<string, unknown>;
    if (call.kind === 'execute') { await this.command(String(input.command ?? input.cmd ?? '')); return; }
    if (!['read','search','edit'].includes(call.kind ?? '')) throw Error('Tool kind is not permitted');
    const paths = [...(call.locations ?? []).map(x=>x.path), ...['path','file_path','target_file','relative_workspace_path'].flatMap(k => typeof input[k] === 'string' ? [input[k] as string] : [])];
    if (!paths.length) throw Error('Permission request lacks verifiable paths');
    for (const p of paths) await this.checkPath(p,call.kind === 'edit');
  }
}
