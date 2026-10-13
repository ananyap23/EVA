/**
 * Standalone Screen State & Windows UI Automation Tester
 * 
 * Run in a terminal on your desktop:
 *   node test_screen_state.js
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  🔍 EVA-01 Screen State Engine & UI Automation Test');
  console.log('════════════════════════════════════════════════════════════════');

  const psScriptPath = path.join(__dirname, 'electron/main/services/vision/get_screen_state.ps1');
  const t0 = Date.now();
  let raw = '';

  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath],
      { timeout: 8000 }
    );

    const elapsed = Date.now() - t0;
    if (stderr && stderr.trim()) {
      console.warn('⚠️ PowerShell Warning/Error:\n', stderr.trim());
    }

    raw = stdout.trim();
    if (!raw) {
      console.log('❌ No output returned from PowerShell.');
      return;
    }

    const state = JSON.parse(raw);

    const cursor = state.Cursor || state.cursor || {};
    console.log(`⏱  Execution Time: ${elapsed}ms`);
    console.log(`🖱  Cursor Position: (${cursor.X ?? cursor.x ?? 0}, ${cursor.Y ?? cursor.y ?? 0})`);

    const fg = state.Foreground || state.foreground;
    console.log('\n📱 ACTIVE FOREGROUND WINDOW:');
    if (fg && (fg.Title || fg.title)) {
      const title = fg.Title || fg.title;
      const proc = fg.ProcessName || fg.process;
      const pid = fg.ProcessId || fg.pid;
      const x = fg.X ?? fg.x ?? 0;
      const y = fg.Y ?? fg.y ?? 0;
      const w = fg.Width ?? fg.width ?? 0;
      const h = fg.Height ?? fg.height ?? 0;
      console.log(`   Title:   "${title}"`);
      console.log(`   Process: ${proc}.exe (PID: ${pid})`);
      console.log(`   Bounds:  [${x}, ${y}, ${w}x${h}]`);
    } else {
      console.log('   (No active application window detected)');
    }

    const rawWindows = state.Windows || state.windows || [];
    const windows = Array.isArray(rawWindows) ? rawWindows : [rawWindows];
    console.log(`\n🪟 OPEN APPLICATION WINDOWS (${windows.length} detected):`);
    for (const w of windows.slice(0, 10)) {
      const title = w.Title || w.title;
      const proc = w.ProcessName || w.process;
      const isFg = w.IsForeground ?? w.isForeground;
      const activeTag = isFg ? ' ★ [FOREGROUND]' : '';
      console.log(`   • "${title}" (${proc}.exe)${activeTag}`);
    }

    const rawElements = state.Elements || state.elements || [];
    const elements = Array.isArray(rawElements) ? rawElements : (rawElements ? [rawElements] : []);
    console.log(`\n🔘 EXTRACTED UI AUTOMATION CONTROLS (${elements.length} controls in target window):`);
    if (elements.length === 0) {
      console.log('   (0 controls extracted - target window might be minimal or custom rendering)');
    } else {
      for (const el of elements) {
        const id = el.Id ?? el.id;
        const name = el.Name ?? el.name;
        const role = el.Role ?? el.type;
        const val = el.Value ? ` = "${el.Value}"` : '';
        const x = el.X ?? el.x;
        const y = el.Y ?? el.y;
        const w = el.Width ?? el.width;
        const h = el.Height ?? el.height;
        console.log(`   [${id}] [${role}] "${name}"${val} → Center: (${x}, ${y}) | Bounds: ${w}x${h}`);
      }
    }

    const rawTaskbar = state.Taskbar || state.taskbar || [];
    const taskbar = Array.isArray(rawTaskbar) ? rawTaskbar : (rawTaskbar ? [rawTaskbar] : []);
    console.log(`\n📌 TASKBAR APPS & LAUNCHERS (${taskbar.length} items found):`);
    if (taskbar.length === 0) {
      console.log('   (No taskbar items extracted)');
    } else {
      for (const tb of taskbar) {
        const name = tb.Name ?? tb.name;
        const role = tb.Role ?? tb.type;
        const x = tb.X ?? tb.x;
        const y = tb.Y ?? tb.y;
        const w = tb.Width ?? tb.width;
        const h = tb.Height ?? tb.height;
        console.log(`   • "${name}" (${role}) → Click: (${x}, ${y}) | Bounds: ${w}x${h}`);
      }
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('✨ Screen State Engine Verification Complete');
    console.log('════════════════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('❌ Failed to run Screen State test:', err.message);
    if (typeof raw === 'string' && raw.length > 0) {
      const match = err.message.match(/position (\d+)/);
      if (match) {
        const pos = parseInt(match[1], 10);
        const start = Math.max(0, pos - 50);
        const end = Math.min(raw.length, pos + 50);
        console.log('\n--- RAW OUTPUT NEAR ERROR (char ' + pos + ') ---');
        console.log(raw.slice(start, end));
        console.log(' '.repeat(Math.max(0, pos - start)) + '^ (ERROR POSITION)');
        console.log('--------------------------------------------------\n');
      }
    }
  }
}

run();
