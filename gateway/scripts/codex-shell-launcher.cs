// Built as runtime/codex-shell/pwsh.exe. The genuine Microsoft runtime remains
// untouched in runtime/powershell7. This process and its child inherit Codex's
// restricted Windows token; no sandbox, policy or profile settings are relaxed.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

internal static class CodexShellLauncher
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleOutputCP(uint codePage);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCP(uint codePage);
    [DllImport("kernel32.dll")]
    private static extern uint GetConsoleOutputCP();
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int Size; public string Reserved; public string Desktop; public string Title;
        public int X, Y, Width, Height, BufferWidth, BufferHeight, Fill, Flags;
        public short ShowWindow, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    private static int RunWithHiddenConsole(string[] args)
    {
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        var command = new StringBuilder(Quote(executable) + " --codex-console-bootstrap ");
        foreach (string arg in args) { command.Append(Quote(arg)); command.Append(' '); }
        var startup = new StartupInfo {
            Size = Marshal.SizeOf(typeof(StartupInfo)),
            Flags = 0x101, // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
            ShowWindow = 0, // SW_HIDE: never show a console window.
            Input = GetStdHandle(-10), Output = GetStdHandle(-11), Error = GetStdHandle(-12)
        };
        ProcessInformation child;
        // CREATE_NEW_CONSOLE gives a headless caller its own console code page.
        // CreateProcess inherits our existing token; it cannot elevate access.
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x10, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            WaitForSingleObject(child.Process, 0xffffffff);
            uint code;
            if (!GetExitCodeProcess(child.Process, out code)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return unchecked((int)code);
        }
        finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
    }
    // CommandLineToArgvW/CRT quoting, including embedded quotes and trailing
    // backslashes. Do not pass these arguments through cmd.exe or a shell.
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); }
            else { result.Append('\\', slashes); result.Append(ch); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    public static int Main(string[] args)
    {
        try
        {
            bool bootstrapped = args.Length > 0 && args[0] == "--codex-console-bootstrap";
            if (bootstrapped) { var forwarded = new string[args.Length - 1]; Array.Copy(args, 1, forwarded, 0, forwarded.Length); args = forwarded; }
            // Always isolate the code page: changing a shared caller console
            // would also affect unrelated commands in that console.
            if (!bootstrapped) return RunWithHiddenConsole(args);
            if (GetConsoleOutputCP() == 0) throw new InvalidOperationException("CODEX_UTF8_INIT_FAILED: No private command console.");
            string target = Environment.GetEnvironmentVariable("CODEX_NATIVE_POWERSHELL_PATH");
            if (String.IsNullOrEmpty(target) || !Path.IsPathRooted(target) || !File.Exists(target))
                throw new InvalidOperationException("CODEX_NATIVE_POWERSHELL_PATH must identify the genuine PowerShell 7 executable.");
            if (String.Equals(Path.GetFullPath(target), Process.GetCurrentProcess().MainModule.FileName, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("PowerShell launcher cannot target itself.");
            // Initialize the inherited command console before PowerShell caches
            // its encoding. Unlike a PowerShell property setter this is allowed
            // in ConstrainedLanguage and does not change the restricted token.
            if (!SetConsoleOutputCP(65001) || !SetConsoleCP(65001)) throw new InvalidOperationException("CODEX_UTF8_INIT_FAILED: Cannot configure the command console.");
            bool noProfile = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (String.Equals(args[i], "-NoProfile", StringComparison.OrdinalIgnoreCase)) noProfile = true;
            }
            var commandLine = new StringBuilder(noProfile ? "" : "-NoProfile ");
            foreach (string arg in args) { commandLine.Append(Quote(arg)); commandLine.Append(' '); }
            var start = new ProcessStartInfo(target, commandLine.ToString()) {
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("CODEX_SHELL_LAUNCH_FAILED: " + error.Message);
            return 125;
        }
    }
}
