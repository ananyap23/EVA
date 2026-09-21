using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Automation;

public class DesktopPerceptionEngine {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    public class WindowInfo {
        public string Title;
        public string ProcessName;
        public uint ProcessId;
        public string Hwnd;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool IsForeground;
    }

    public class UIElementInfo {
        public int Id;
        public string Name;
        public string Role;
        public string Value;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public string AutomationId;
        public string ClassName;
        public bool IsEnabled;
        public bool HasKeyboardFocus;
    }

    public class TaskbarItemInfo {
        public int Id;
        public string Name;
        public string Role;
        public int X;
        public int Y;
        public int Width;
        public int Height;
    }

    public class DesktopSnapshot {
        public POINT Cursor;
        public WindowInfo Foreground;
        public List<WindowInfo> Windows = new List<WindowInfo>();
        public List<UIElementInfo> Elements = new List<UIElementInfo>();
        public List<TaskbarItemInfo> Taskbar = new List<TaskbarItemInfo>();
    }

    private static string SanitizeString(string s, int maxLength = 120) {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder();
        foreach (char c in s) {
            if (c >= 32 && c != 127) {
                sb.Append(c);
            } else if (c == '\t' || c == '\n' || c == '\r') {
                sb.Append(' ');
            }
            if (sb.Length >= maxLength) break;
        }
        return sb.ToString().Trim();
    }

    public static string EscapeJsonString(string s) {
        if (string.IsNullOrEmpty(s)) return "\"\"";
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s) {
            switch (c) {
                case '\\': sb.Append("\\\\"); break;
                case '\"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32 || c >= 127) {
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    } else {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static DesktopSnapshot CaptureSnapshot() {
        var snapshot = new DesktopSnapshot();
        GetCursorPos(out snapshot.Cursor);

        IntPtr fg = GetForegroundWindow();

        // 1. Enumerate Windows via EnumWindows
        try {
            EnumWindows((hWnd, lParam) => {
                if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;

                RECT rect;
                GetWindowRect(hWnd, out rect);
                int w = rect.Right - rect.Left;
                int h = rect.Bottom - rect.Top;
                if (w < 60 || h < 60) return true;

                var sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString().Trim();
                if (string.IsNullOrEmpty(title)) return true;

                if (title == "Program Manager" || title == "Windows Shell Experience Host" || title == "Windows Input Experience") return true;

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = "unknown";
                try {
                    var p = Process.GetProcessById((int)pid);
                    procName = p.ProcessName;
                } catch {}

                var win = new WindowInfo {
                    Title = SanitizeString(title, 150),
                    ProcessName = SanitizeString(procName, 60),
                    ProcessId = pid,
                    Hwnd = hWnd.ToString(),
                    X = rect.Left,
                    Y = rect.Top,
                    Width = w,
                    Height = h,
                    IsForeground = (hWnd == fg)
                };

                snapshot.Windows.Add(win);
                return true;
            }, IntPtr.Zero);
        } catch {}

        // Fallback: If EnumWindows returned nothing, check active process windows
        if (snapshot.Windows.Count == 0) {
            try {
                var procs = Process.GetProcesses();
                foreach (var p in procs) {
                    IntPtr h = p.MainWindowHandle;
                    if (h != IntPtr.Zero && !string.IsNullOrEmpty(p.MainWindowTitle)) {
                        RECT rect;
                        GetWindowRect(h, out rect);
                        int w = rect.Right - rect.Left;
                        int hDim = rect.Bottom - rect.Top;
                        snapshot.Windows.Add(new WindowInfo {
                            Title = SanitizeString(p.MainWindowTitle, 150),
                            ProcessName = SanitizeString(p.ProcessName, 60),
                            ProcessId = (uint)p.Id,
                            Hwnd = h.ToString(),
                            X = rect.Left,
                            Y = rect.Top,
                            Width = w > 0 ? w : 800,
                            Height = hDim > 0 ? hDim : 600,
                            IsForeground = (h == fg)
                        });
                    }
                }
            } catch {}
        }

        // 2. Select Target Foreground Window (avoiding EVA-01)
        WindowInfo targetWin = null;
        foreach (var w in snapshot.Windows) {
            if (w.IsForeground) {
                targetWin = w;
                break;
            }
        }

        if (targetWin == null || targetWin.ProcessName.ToLower().Contains("electron") || targetWin.Title.Contains("EVA-01")) {
            foreach (var w in snapshot.Windows) {
                if (!w.ProcessName.ToLower().Contains("electron") && !w.Title.Contains("EVA-01")) {
                    targetWin = w;
                    break;
                }
            }
        }

        snapshot.Foreground = targetWin;

        // 3. Extract UI Automation Controls from Target Window
        if (targetWin != null) {
            try {
                IntPtr hwnd = new IntPtr(long.Parse(targetWin.Hwnd));
                AutomationElement winEl = AutomationElement.FromHandle(hwnd);
                if (winEl != null) {
                    ExtractControlsRecursive(winEl, snapshot.Elements, 0, 45);
                }
            } catch {}
        }

        // 4. Extract Taskbar Items
        try {
            AutomationElement tbEl = AutomationElement.RootElement.FindFirst(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd")
            );
            if (tbEl == null) {
                IntPtr tbHwnd = FindWindow("Shell_TrayWnd", null);
                if (tbHwnd != IntPtr.Zero) {
                    tbEl = AutomationElement.FromHandle(tbHwnd);
                }
            }
            if (tbEl != null) {
                ExtractTaskbarRecursive(tbEl, snapshot.Taskbar, 0, 30);
            }
        } catch {}

        return snapshot;
    }

    public static string CaptureSnapshotJson() {
        var snap = CaptureSnapshot();
        var sb = new StringBuilder();
        sb.Append('{');

        // Cursor
        sb.Append("\"Cursor\":{\"X\":").Append(snap.Cursor.X).Append(",\"Y\":").Append(snap.Cursor.Y).Append("},");

        // Foreground
        sb.Append("\"Foreground\":");
        if (snap.Foreground != null) {
            sb.Append('{');
            sb.Append("\"Title\":").Append(EscapeJsonString(snap.Foreground.Title)).Append(',');
            sb.Append("\"ProcessName\":").Append(EscapeJsonString(snap.Foreground.ProcessName)).Append(',');
            sb.Append("\"ProcessId\":").Append(snap.Foreground.ProcessId).Append(',');
            sb.Append("\"Hwnd\":").Append(EscapeJsonString(snap.Foreground.Hwnd)).Append(',');
            sb.Append("\"X\":").Append(snap.Foreground.X).Append(',');
            sb.Append("\"Y\":").Append(snap.Foreground.Y).Append(',');
            sb.Append("\"Width\":").Append(snap.Foreground.Width).Append(',');
            sb.Append("\"Height\":").Append(snap.Foreground.Height).Append(',');
            sb.Append("\"IsForeground\":true");
            sb.Append("},");
        } else {
            sb.Append("null,");
        }

        // Windows
        sb.Append("\"Windows\":[");
        for (int i = 0; i < snap.Windows.Count; i++) {
            var w = snap.Windows[i];
            if (i > 0) sb.Append(',');
            sb.Append('{');
            sb.Append("\"Title\":").Append(EscapeJsonString(w.Title)).Append(',');
            sb.Append("\"ProcessName\":").Append(EscapeJsonString(w.ProcessName)).Append(',');
            sb.Append("\"ProcessId\":").Append(w.ProcessId).Append(',');
            sb.Append("\"Hwnd\":").Append(EscapeJsonString(w.Hwnd)).Append(',');
            sb.Append("\"X\":").Append(w.X).Append(',');
            sb.Append("\"Y\":").Append(w.Y).Append(',');
            sb.Append("\"Width\":").Append(w.Width).Append(',');
            sb.Append("\"Height\":").Append(w.Height).Append(',');
            sb.Append("\"IsForeground\":").Append(w.IsForeground ? "true" : "false");
            sb.Append('}');
        }
        sb.Append("],");

        // Elements
        sb.Append("\"Elements\":[");
        for (int i = 0; i < snap.Elements.Count; i++) {
            var el = snap.Elements[i];
            if (i > 0) sb.Append(',');
            sb.Append('{');
            sb.Append("\"Id\":").Append(el.Id).Append(',');
            sb.Append("\"Name\":").Append(EscapeJsonString(el.Name)).Append(',');
            sb.Append("\"Role\":").Append(EscapeJsonString(el.Role)).Append(',');
            sb.Append("\"Value\":").Append(EscapeJsonString(el.Value)).Append(',');
            sb.Append("\"X\":").Append(el.X).Append(',');
            sb.Append("\"Y\":").Append(el.Y).Append(',');
            sb.Append("\"Width\":").Append(el.Width).Append(',');
            sb.Append("\"Height\":").Append(el.Height).Append(',');
            sb.Append("\"AutomationId\":").Append(EscapeJsonString(el.AutomationId)).Append(',');
            sb.Append("\"ClassName\":").Append(EscapeJsonString(el.ClassName)).Append(',');
            sb.Append("\"IsEnabled\":").Append(el.IsEnabled ? "true" : "false").Append(',');
            sb.Append("\"HasKeyboardFocus\":").Append(el.HasKeyboardFocus ? "true" : "false");
            sb.Append('}');
        }
        sb.Append("],");

        // Taskbar
        sb.Append("\"Taskbar\":[");
        for (int i = 0; i < snap.Taskbar.Count; i++) {
            var t = snap.Taskbar[i];
            if (i > 0) sb.Append(',');
            sb.Append('{');
            sb.Append("\"Id\":").Append(t.Id).Append(',');
            sb.Append("\"Name\":").Append(EscapeJsonString(t.Name)).Append(',');
            sb.Append("\"Role\":").Append(EscapeJsonString(t.Role)).Append(',');
            sb.Append("\"X\":").Append(t.X).Append(',');
            sb.Append("\"Y\":").Append(t.Y).Append(',');
            sb.Append("\"Width\":").Append(t.Width).Append(',');
            sb.Append("\"Height\":").Append(t.Height);
            sb.Append('}');
        }
        sb.Append(']');

        sb.Append('}');
        return sb.ToString();
    }

    private static void ExtractControlsRecursive(AutomationElement el, List<UIElementInfo> list, int depth, int maxCount) {
        if (el == null || list.Count >= maxCount || depth > 8) return;

        try {
            var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement child in children) {
                if (list.Count >= maxCount) break;

                try {
                    var current = child.Current;
                    var rect = current.BoundingRectangle;

                    string name = current.Name ?? "";
                    string autoId = current.AutomationId ?? "";
                    string role = current.ControlType != null ? current.ControlType.ProgrammaticName.Replace("ControlType.", "") : "Custom";
                    string className = current.ClassName ?? "";

                    if (rect.Width > 6 && rect.Height > 6 && rect.X >= -100 && rect.Y >= -100) {
                        string rawDisp = !string.IsNullOrWhiteSpace(name) ? name : autoId;
                        string disp = SanitizeString(rawDisp, 100);

                        bool isInteractive = role == "Button" || role == "Edit" || role == "MenuItem" || role == "TabItem" ||
                                             role == "CheckBox" || role == "Hyperlink" || role == "ComboBox" || role == "ListItem" ||
                                             role == "TreeItem" || role == "Document" || (role == "Text" && disp.Length > 2);

                        if (isInteractive && !string.IsNullOrWhiteSpace(disp)) {
                            string val = "";
                            try {
                                object valPattern;
                                if (child.TryGetCurrentPattern(ValuePattern.Pattern, out valPattern)) {
                                    val = SanitizeString(((ValuePattern)valPattern).Current.Value, 150);
                                }
                            } catch {}

                            list.Add(new UIElementInfo {
                                Id = list.Count + 1,
                                Name = disp,
                                Role = role,
                                Value = val,
                                X = (int)(rect.X + (rect.Width / 2)),
                                Y = (int)(rect.Y + (rect.Height / 2)),
                                Width = (int)rect.Width,
                                Height = (int)rect.Height,
                                AutomationId = SanitizeString(autoId, 60),
                                ClassName = SanitizeString(className, 60),
                                IsEnabled = current.IsEnabled,
                                HasKeyboardFocus = current.HasKeyboardFocus
                            });
                        }
                    }

                    ExtractControlsRecursive(child, list, depth + 1, maxCount);
                } catch {}
            }
        } catch {}
    }

    private static void ExtractTaskbarRecursive(AutomationElement el, List<TaskbarItemInfo> list, int depth, int maxCount) {
        if (el == null || list.Count >= maxCount || depth > 6) return;

        try {
            var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement child in children) {
                if (list.Count >= maxCount) break;

                try {
                    var current = child.Current;
                    var rect = current.BoundingRectangle;
                    string name = current.Name ?? "";
                    string role = current.ControlType != null ? current.ControlType.ProgrammaticName.Replace("ControlType.", "") : "";

                    if (rect.Width > 8 && rect.Height > 8 && !string.IsNullOrWhiteSpace(name)) {
                        bool isTaskbarControl = role == "Button" || role == "ToolBar" || role == "MenuItem" || role == "TabItem" || role == "Pane" || role == "Custom";
                        if (isTaskbarControl) {
                            string cleanName = SanitizeString(name, 80);
                            if (!cleanName.Contains("System.Windows") && !cleanName.Contains("User32") && cleanName != "Taskbar" && cleanName.Length > 1) {
                                list.Add(new TaskbarItemInfo {
                                    Id = list.Count + 1,
                                    Name = cleanName,
                                    Role = role,
                                    X = (int)(rect.X + (rect.Width / 2)),
                                    Y = (int)(rect.Y + (rect.Height / 2)),
                                    Width = (int)rect.Width,
                                    Height = (int)rect.Height
                                });
                            }
                        }
                    }

                    ExtractTaskbarRecursive(child, list, depth + 1, maxCount);
                } catch {}
            }
        } catch {}
    }
}
