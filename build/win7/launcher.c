/*
 * Pulsar Zero 4000 launcher for Windows 7 / 8 / 8.1.
 * Starts  runtime\pulsar-zero4000-engine.exe runtime\app.js [args]  in this console window and waits for it.
 * Uses only Win32 calls available since Windows XP (no Windows 8+ APIs).
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static void pause_and_exit(int code) {
  wprintf(L"\nPress Enter to close this window.\n");
  getwchar();
  ExitProcess(code);
}

int wmain(void) {
  wchar_t exe[MAX_PATH], dir[MAX_PATH], node[MAX_PATH], app[MAX_PATH];
  SetConsoleTitleW(L"Pulsar Zero 4000");
  DWORD n = GetModuleFileNameW(NULL, exe, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) { wprintf(L"Could not find where this program is.\n"); pause_and_exit(1); }
  wcscpy(dir, exe);
  wchar_t *slash = wcsrchr(dir, L'\\');
  if (slash) *slash = 0;
  _snwprintf(node, MAX_PATH, L"%s\\runtime\\pulsar-zero4000-engine.exe", dir);
  _snwprintf(app, MAX_PATH, L"%s\\runtime\\app.js", dir);
  if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(app) == INVALID_FILE_ATTRIBUTES) {
    MessageBoxW(NULL, L"The \"runtime\" folder is missing.\n\nKeep \"Pulsar Zero 4000.exe\" in the same folder as the \"runtime\" folder "
                      L"it came with (unzip the whole download, don't move the .exe on its own).",
                L"Pulsar Zero 4000", MB_ICONERROR | MB_OK);
    return 1;
  }

  /* pass through any arguments given to the launcher */
  const wchar_t *cl = GetCommandLineW();
  if (*cl == L'"') { cl++; while (*cl && *cl != L'"') cl++; if (*cl) cl++; }
  else { while (*cl && *cl != L' ' && *cl != L'\t') cl++; }
  while (*cl == L' ' || *cl == L'\t') cl++;

  size_t len = wcslen(node) + wcslen(app) + wcslen(cl) + 16;
  wchar_t *cmd = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, len * sizeof(wchar_t));
  _snwprintf(cmd, len, L"\"%s\" \"%s\" %s", node, app, cl);

  STARTUPINFOW si; PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  ZeroMemory(&pi, sizeof pi);
  if (!CreateProcessW(node, cmd, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi)) {
    wprintf(L"Could not start the Pulsar Zero 4000 runtime (error %lu).\n", GetLastError());
    pause_and_exit(1);
  }
  /* Ctrl+C goes to both processes; let the runtime handle it and shut down cleanly */
  SetConsoleCtrlHandler(NULL, TRUE);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  if (code != 0) {
    wprintf(L"\nPulsar Zero 4000 stopped with an error (code %lu). The message above says why.\n", code);
    pause_and_exit((int)code);
  }
  return 0;
}
