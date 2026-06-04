/**
 * @name AutoIdleOnSystemAFK
 * @author Athena
 * @version 1.0.0
 * @description Sets your Discord status to idle (or invisible/dnd) when your PC has no mouse or keyboard activity for X minutes, regardless of whether the Discord window is focused. Reverts to online when you come back. Restores Discord's old built-in auto-idle behavior.
 * @source https://github.com/LimeLabStudios/AutoIdleOnSystemAFK/blob/main/AutoIdleOnSystemAFK.plugin.js
 * @updateUrl https://raw.githubusercontent.com/LimeLabStudios/AutoIdleOnSystemAFK/main/AutoIdleOnSystemAFK.plugin.js
 */

module.exports = class AutoIdleOnSystemAFK {
    constructor(meta) {
        this.meta = meta;
        this.name = (meta && meta.name) || "AutoIdleOnSystemAFK";
        this.idleSetByPluginKey = "IdleSetByPlugin";

        this.defaults = {
            activeStatus: "online",
            afkStatus: "idle",
            afkTimeoutMin: 5,
            backOnlineDelaySec: 5,
            pollIntervalSec: 5,
            ignoreVCState: false,
            alwaysOnline: false,
            showToasts: true,
            showDebug: false,
        };

        this.settings = Object.assign({}, this.defaults, BdApi.Data.load(this.name, "settings") || {});

        this.pollTimerID = null;
        this.backOnlineTimerID = null;
        this.idleSource = null;

        this.resolveModules();
    }

    resolveModules() {
        try {
            this.UserSettingsProtoStore = BdApi.Webpack.getModule(
                m => m && typeof m.getName === "function" && m.getName() === "UserSettingsProtoStore" && m,
                { first: true, searchExports: true }
            );
        } catch (e) { this.UserSettingsProtoStore = null; }

        try {
            this.UserSettingsProtoUtils = BdApi.Webpack.getModule(
                m => m && m.ProtoClass && m.ProtoClass.typeName && m.ProtoClass.typeName.endsWith(".PreloadedUserSettings"),
                { first: true, searchExports: true }
            );
        } catch (e) { this.UserSettingsProtoUtils = null; }

        try {
            this.SelectedChannelStore = BdApi.Webpack.getByKeys("getLastSelectedChannelId");
        } catch (e) { this.SelectedChannelStore = null; }
    }

    diag(msg) {
        this._diag = this._diag || [];
        this._diag.push(msg);
        console.log("[AutoIdleOnSystemAFK] " + msg);
    }

    async validateGetter(name, fn) {
        try {
            let v = fn();
            const wasPromise = !!(v && typeof v.then === "function");
            if (wasPromise) v = await v;
            if (typeof v === "number" && isFinite(v) && v >= 0) {
                this.diag(`probe '${name}' -> ${v.toFixed(2)}s (OK${wasPromise ? ", async" : ""})`);
                return true;
            }
            this.diag(`probe '${name}' -> ${v} (invalid, skipping)`);
        } catch (err) {
            this.diag(`probe '${name}' threw: ${err && err.message}`);
        }
        return false;
    }

    async probeIdleSource() {
        this._diag = [];
        const candidates = [];

        try {
            const dn = (typeof DiscordNative !== "undefined") ? DiscordNative : null;
            if (dn) {
                try { this.diag("DiscordNative keys: " + Object.keys(dn).join(",")); } catch {}
                if (dn.powerMonitor) {
                    try { this.diag("DiscordNative.powerMonitor keys: " + Object.keys(dn.powerMonitor).join(",")); } catch {}
                } else {
                    this.diag("DiscordNative.powerMonitor is undefined");
                }
                if (dn.powerMonitor && typeof dn.powerMonitor.getSystemIdleTimeMs === "function") {
                    candidates.push({
                        name: "DiscordNative.powerMonitor.getSystemIdleTimeMs",
                        get: async () => {
                            const ms = await dn.powerMonitor.getSystemIdleTimeMs();
                            return (typeof ms === "number") ? ms / 1000 : NaN;
                        },
                    });
                }
                if (dn.powerMonitor && typeof dn.powerMonitor.getSystemIdleTime === "function") {
                    candidates.push({
                        name: "DiscordNative.powerMonitor.getSystemIdleTime",
                        get: async () => await dn.powerMonitor.getSystemIdleTime(),
                    });
                }
                if (dn.processUtils && typeof dn.processUtils.getSystemIdleTime === "function") {
                    candidates.push({ name: "DiscordNative.processUtils.getSystemIdleTime", get: () => dn.processUtils.getSystemIdleTime() });
                }
            } else {
                this.diag("DiscordNative is undefined");
            }
        } catch (e) { this.diag("DiscordNative probe error: " + (e && e.message)); }

        try {
            const electron = require("electron");
            this.diag("electron require: " + (electron ? "ok, keys=" + Object.keys(electron).slice(0, 20).join(",") : "null"));
            const pm = electron && (electron.powerMonitor || (electron.remote && electron.remote.powerMonitor));
            if (pm && typeof pm.getSystemIdleTime === "function") {
                candidates.push({ name: "electron.powerMonitor.getSystemIdleTime", get: () => pm.getSystemIdleTime() });
            } else {
                this.diag("electron.powerMonitor not available");
            }
        } catch (e) { this.diag("electron probe error: " + (e && e.message)); }

        this.diag(`candidate count: ${candidates.length}`);
        for (const c of candidates) {
            if (await this.validateGetter(c.name, c.get)) {
                this.idleSourceName = c.name;
                return c.get;
            }
        }

        this.diag("platform: " + process.platform);
        const psSource = this.startPowerShellHelper();
        if (psSource) {
            this.idleSourceName = "PowerShell GetLastInputInfo";
            return psSource;
        }

        return null;
    }

    showDiagnosticModal() {
        const text = (this._diag || []).join("\n") || "(no diagnostic messages captured)";
        try {
            BdApi.UI.alert(
                "AutoIdleOnSystemAFK — Diagnostic",
                "No working system idle time source was found. Details:\n\n" + text +
                "\n\nPlease share this text so I can add the right idle source."
            );
        } catch (e) {
            BdApi.UI.showToast("AutoIdleOnSystemAFK: diagnostic modal failed; see plugins folder for log.", { type: "error", timeout: 8000 });
        }
        try {
            const fs = require("fs");
            const path = require("path");
            const logPath = path.join(BdApi.Plugins.folder, this.name + ".diag.txt");
            fs.writeFileSync(logPath, text, "utf8");
        } catch (e) {}
    }

    startPowerShellHelper() {
        if (process.platform !== "win32") {
            this.diag("PS helper skipped (not win32)");
            return null;
        }
        let spawn;
        try {
            spawn = require("child_process").spawn;
        } catch (err) {
            this.diag("PS helper: require('child_process') failed: " + (err && err.message));
            return null;
        }
        try {
            const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IdleProbe {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    public static uint GetIdleMs() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(lii);
        GetLastInputInfo(ref lii);
        return GetTickCount() - lii.dwTime;
    }
}
"@
while ($true) {
    Write-Output ([IdleProbe]::GetIdleMs())
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 2000
}
`;
            const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            this._psChild = child;
            this._psLastMs = -1;
            let buf = "";
            child.stdout.on("data", (chunk) => {
                buf += chunk.toString();
                const lines = buf.split(/\r?\n/);
                buf = lines.pop();
                for (const line of lines) {
                    const n = parseInt(line.trim(), 10);
                    if (isFinite(n) && n >= 0) this._psLastMs = n;
                }
            });
            child.stderr.on("data", (chunk) => {
                console.error("[AutoIdleOnSystemAFK] PS stderr:", chunk.toString());
            });
            child.on("exit", (code) => {
                console.log("[AutoIdleOnSystemAFK] PS helper exited with code", code);
                this._psChild = null;
            });
            this.diag("PowerShell helper spawned (pid " + child.pid + ")");
            return () => (this._psLastMs >= 0 ? this._psLastMs / 1000 : NaN);
        } catch (err) {
            this.diag("PS spawn failed: " + (err && err.message));
            return null;
        }
    }

    stopPowerShellHelper() {
        if (this._psChild) {
            try { this._psChild.kill(); } catch (e) {}
            this._psChild = null;
        }
    }

    getSettingsPanel() {
        return BdApi.UI.buildSettingsPanel({
            settings: [
                {
                    type: "radio",
                    name: "Active Status",
                    note: "Status to use (and revert to) when you are NOT AFK. Default: Online",
                    id: "activeStatus",
                    value: this.settings.activeStatus,
                    options: [
                        { name: "Online", value: "online" },
                        { name: "Do Not Disturb", value: "dnd" },
                    ],
                },
                {
                    type: "radio",
                    name: "Status when AFK",
                    note: "Status to switch to when your PC is idle. Default: Idle",
                    id: "afkStatus",
                    value: this.settings.afkStatus,
                    options: [
                        { name: "Idle", value: "idle" },
                        { name: "Invisible", value: "invisible" },
                        { name: "Do Not Disturb", value: "dnd" },
                    ],
                },
                {
                    type: "slider",
                    name: "AFK Timeout (minutes)",
                    note: "Minutes of system-wide inactivity (no mouse/keyboard) before switching status.",
                    id: "afkTimeoutMin",
                    value: this.settings.afkTimeoutMin,
                    defaultValue: 5,
                    min: 1,
                    max: 30,
                    units: " min",
                    markers: [1, 5, 10, 15, 20, 25, 30],
                },
                {
                    type: "slider",
                    name: "Back to Online Delay (seconds)",
                    note: "Seconds of detected activity before switching back to Online (grace period).",
                    id: "backOnlineDelaySec",
                    value: this.settings.backOnlineDelaySec,
                    defaultValue: 5,
                    min: 0,
                    max: 60,
                    units: " s",
                    markers: [0, 5, 10, 30, 60],
                },
                {
                    type: "slider",
                    name: "Check Interval (seconds)",
                    note: "How often the plugin polls system idle time. Lower = faster reaction, slightly higher CPU.",
                    id: "pollIntervalSec",
                    value: this.settings.pollIntervalSec,
                    defaultValue: 5,
                    min: 1,
                    max: 60,
                    units: " s",
                    markers: [1, 5, 10, 30, 60],
                },
                {
                    type: "switch",
                    name: "Ignore VC state when going AFK",
                    note: "Allows going AFK even when you're in a voice channel. Default: off.",
                    id: "ignoreVCState",
                    value: this.settings.ignoreVCState,
                },
                {
                    type: "switch",
                    name: "Always revert to Active",
                    note: "Switch back to your Active Status when you return even if this plugin did not set the AFK status (useful with mobile/other clients).",
                    id: "alwaysOnline",
                    value: this.settings.alwaysOnline,
                },
                {
                    type: "switch",
                    name: "Show toast messages",
                    note: "Show a toast when status changes back to your Active Status.",
                    id: "showToasts",
                    value: this.settings.showToasts,
                },
                {
                    type: "switch",
                    name: "Debug mode",
                    note: "Log debug info to the console and use SECONDS instead of minutes for AFK timeout (for testing).",
                    id: "showDebug",
                    value: this.settings.showDebug,
                },
            ],
            onChange: (_category, id, value) => {
                this.settings[id] = value;
                BdApi.Data.save(this.name, "settings", this.settings);
                if (id === "pollIntervalSec") this.restartPolling();
            },
        });
    }

    async start() {
        this.idleSource = await this.probeIdleSource();
        if (!this.idleSource) {
            BdApi.UI.showToast(
                "AutoIdleOnSystemAFK: no idle source. Opening diagnostic…",
                { type: "error", timeout: 6000 }
            );
            this.showDiagnosticModal();
            return;
        }
        if (!this.UserSettingsProtoStore || !this.UserSettingsProtoUtils) {
            BdApi.UI.showToast(
                "AutoIdleOnSystemAFK: required Discord modules not found. Discord may have updated; check console.",
                { type: "error", timeout: 10000 }
            );
            console.error("[AutoIdleOnSystemAFK] UserSettingsProtoStore/Utils not resolved.");
            return;
        }
        BdApi.UI.showToast(
            `AutoIdleOnSystemAFK active — using ${this.idleSourceName}`,
            { type: "success", timeout: 6000 }
        );
        console.log("[AutoIdleOnSystemAFK] started; idle source =", this.idleSourceName);
        this.startPolling();
    }

    stop() {
        if (this.pollTimerID) clearInterval(this.pollTimerID);
        if (this.backOnlineTimerID) clearTimeout(this.backOnlineTimerID);
        this.pollTimerID = null;
        this.backOnlineTimerID = null;
        this.stopPowerShellHelper();
        this.debug("stopped");
    }

    restartPolling() {
        if (this.pollTimerID) clearInterval(this.pollTimerID);
        this.pollTimerID = null;
        if (this.idleSource) this.startPolling();
    }

    startPolling() {
        const intervalMs = Math.max(1, this.settings.pollIntervalSec) * 1000;
        this.pollTimerID = setInterval(async () => {
            try {
                const seconds = await this.idleSource();
                this.tick(seconds);
            } catch (err) {
                console.error("[AutoIdleOnSystemAFK] tick error:", err);
            }
        }, intervalMs);
    }

    tick(idleSeconds) {
        if (typeof idleSeconds !== "number" || !isFinite(idleSeconds) || idleSeconds < 0) {
            this.debug(`skipping tick — invalid idle reading: ${idleSeconds}`);
            return;
        }

        const status = this.currentStatus();
        if (!status) {
            this.debug("skipping tick — currentStatus() returned null/undefined");
            return;
        }

        const activeStatus = this.settings.activeStatus;
        const afkStatus = this.settings.afkStatus;
        if (activeStatus === afkStatus) return;

        const inVC = this.inVoiceChannel();
        const threshold = this.settings.afkTimeoutMin * (this.settings.showDebug ? 1 : 60);
        const idleSetByPlugin = BdApi.Data.load(this.name, this.idleSetByPluginKey) === true;

        this.debug(`idle=${idleSeconds.toFixed(1)}s status=${status} active=${activeStatus} afk=${afkStatus} inVC=${inVC} threshold=${threshold}s setByPlugin=${idleSetByPlugin}`);

        if (idleSeconds >= threshold) {
            if (this.backOnlineTimerID) {
                clearTimeout(this.backOnlineTimerID);
                this.backOnlineTimerID = null;
                this.debug("cancelled pending back-to-active (re-idle)");
            }

            if (status === activeStatus && (!inVC || this.settings.ignoreVCState)) {
                this.updateStatus(afkStatus);
                BdApi.Data.save(this.name, this.idleSetByPluginKey, true);
                this.debug(`switched to ${afkStatus}`);
            } else if (inVC && this.settings.alwaysOnline && status === afkStatus) {
                this.updateStatus(activeStatus);
                BdApi.Data.save(this.name, this.idleSetByPluginKey, false);
                this.showToast(`Changing status back to ${activeStatus} (in VC)`);
            }
            return;
        }

        if (status === afkStatus && (idleSetByPlugin || this.settings.alwaysOnline)) {
            if (this.backOnlineTimerID) return;
            const delayMs = Math.max(0, this.settings.backOnlineDelaySec) * 1000;
            this.backOnlineTimerID = setTimeout(async () => {
                this.backOnlineTimerID = null;
                if (this.currentStatus() !== afkStatus) return;
                try {
                    const currentIdle = await this.idleSource();
                    if (typeof currentIdle === "number" && currentIdle >= threshold) return;
                } catch (e) {}
                this.updateStatus(activeStatus);
                BdApi.Data.save(this.name, this.idleSetByPluginKey, false);
                this.showToast(`Changing status back to ${activeStatus}`);
                this.debug(`reverted to ${activeStatus}`);
            }, delayMs);
        } else if (status !== afkStatus && idleSetByPlugin) {
            BdApi.Data.delete(this.name, this.idleSetByPluginKey);
            this.debug("user changed status manually — cleared plugin flag");
        }
    }

    currentStatus() {
        try {
            return this.UserSettingsProtoStore.settings.status.status.value;
        } catch (e) {
            return null;
        }
    }

    inVoiceChannel() {
        try {
            return this.SelectedChannelStore && this.SelectedChannelStore.getVoiceChannelId() != null;
        } catch (e) {
            return false;
        }
    }

    updateStatus(toStatus) {
        try {
            this.UserSettingsProtoUtils.updateAsync(
                "status",
                (statusSetting) => { statusSetting.status.value = toStatus; },
                0
            );
        } catch (err) {
            console.error("[AutoIdleOnSystemAFK] updateStatus error:", err);
        }
    }

    showToast(msg) {
        if (this.settings.showToasts) BdApi.UI.showToast(msg);
    }

    debug(...args) {
        if (this.settings.showDebug) console.log("[AutoIdleOnSystemAFK]", ...args);
    }
};
