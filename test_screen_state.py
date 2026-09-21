"""
Standalone Screen State & Windows UI Automation Tester (Python)

Run in a terminal on your desktop:
    python test_screen_state.py
"""

import subprocess
import json
import time
import os
import sys

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def main():
    print("=" * 64)
    print("  [EVA-01] Screen State Engine & UI Automation Test (Python)")
    print("=" * 64)

    script_path = os.path.join(os.path.dirname(__file__), "electron", "main", "services", "vision", "get_screen_state.ps1")
    t0 = time.time()

    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script_path],
            capture_output=True,
            text=True,
            timeout=12,
            encoding='utf-8',
            errors='replace'
        )
        elapsed_ms = int((time.time() - t0) * 1000)

        if proc.stderr and proc.stderr.strip():
            print("[Warning/Stderr]:\n", proc.stderr.strip())

        output = proc.stdout.strip()
        if not output:
            print("[Error] No output returned from PowerShell.")
            return

        state = json.loads(output)

        print(f"[*] Execution Time: {elapsed_ms}ms")
        cursor = state.get("Cursor") or state.get("cursor") or {}
        print(f"[*] Cursor Position: ({cursor.get('X', cursor.get('x', 0))}, {cursor.get('Y', cursor.get('y', 0))})")

        fg = state.get("Foreground") or state.get("foreground") or {}
        print("\n[ACTIVE FOREGROUND WINDOW]:")
        if fg and (fg.get("Title") or fg.get("title")):
            title = fg.get("Title") or fg.get("title")
            proc_name = fg.get("ProcessName") or fg.get("process")
            pid = fg.get("ProcessId") or fg.get("pid")
            x = fg.get("X", fg.get("x", 0))
            y = fg.get("Y", fg.get("y", 0))
            w = fg.get("Width", fg.get("width", 0))
            h = fg.get("Height", fg.get("height", 0))
            print(f'   Title:   "{title}"')
            print(f'   Process: {proc_name}.exe (PID: {pid})')
            print(f'   Bounds:  [{x}, {y}, {w}x{h}]')
        else:
            print("   (No active application window detected)")

        raw_windows = state.get("Windows") or state.get("windows") or []
        windows = raw_windows if isinstance(raw_windows, list) else [raw_windows]
        print(f"\n[OPEN APPLICATION WINDOWS] ({len(windows)} detected):")
        for w in windows[:10]:
            title = w.get("Title") or w.get("title")
            proc_name = w.get("ProcessName") or w.get("process")
            is_fg = w.get("IsForeground") if "IsForeground" in w else w.get("isForeground")
            active_tag = " * [FOREGROUND]" if is_fg else ""
            print(f'   - "{title}" ({proc_name}.exe){active_tag}')

        raw_elements = state.get("Elements") or state.get("elements") or []
        elements = raw_elements if isinstance(raw_elements, list) else ([raw_elements] if raw_elements else [])
        print(f"\n[EXTRACTED UI AUTOMATION CONTROLS] ({len(elements)} controls in target window):")
        if not elements:
            print("   (0 controls extracted - target window might be minimal or custom rendering)")
        else:
            for el in elements:
                el_id = el.get("Id", el.get("id"))
                name = el.get("Name", el.get("name"))
                role = el.get("Role", el.get("type"))
                val = f' = "{el.get("Value")}"' if el.get("Value") else ""
                x = el.get("X", el.get("x"))
                y = el.get("Y", el.get("y"))
                w = el.get("Width", el.get("width"))
                h = el.get("Height", el.get("height"))
                print(f'   [{el_id}] [{role}] "{name}"{val} -> Center: ({x}, {y}) | Bounds: {w}x{h}')

        raw_taskbar = state.get("Taskbar") or state.get("taskbar") or []
        taskbar = raw_taskbar if isinstance(raw_taskbar, list) else ([raw_taskbar] if raw_taskbar else [])
        print(f"\n[TASKBAR APPS & LAUNCHERS] ({len(taskbar)} items found):")
        if not taskbar:
            print("   (No taskbar items extracted)")
        else:
            for tb in taskbar:
                name = tb.get("Name", tb.get("name"))
                role = tb.get("Role", tb.get("type"))
                x = tb.get("X", tb.get("x"))
                y = tb.get("Y", tb.get("y"))
                w = tb.get("Width", tb.get("width"))
                h = tb.get("Height", tb.get("height"))
                print(f'   - "{name}" ({role}) -> Click: ({x}, {y}) | Bounds: {w}x{h}')

        print("\n" + "=" * 64)
        print("Screen State Engine Verification Complete")
        print("=" * 64 + "\n")

    except Exception as e:
        print(f"[Error] Failed to execute test: {e}")
        if 'output' in locals() and output:
            import re
            m = re.search(r'char (\d+)', str(e))
            if m:
                pos = int(m.group(1))
                start = max(0, pos - 50)
                end = min(len(output), pos + 50)
                print(f"\n--- RAW OUTPUT NEAR ERROR (char {pos}) ---")
                print(output[start:end])
                print(" " * (pos - start) + "^ (ERROR POSITION)")
                print("--------------------------------------------------\n")

if __name__ == "__main__":
    main()
