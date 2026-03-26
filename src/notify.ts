import os from "os"
import { exec, execFile, execFileSync } from "child_process"
import notifier from "node-notifier"

const DEBOUNCE_MS = 1000

const platform = os.type()

let platformNotifier: any

if (platform === "Linux" || platform.match(/BSD$/)) {
  const { NotifySend } = notifier
  platformNotifier = new NotifySend({ withFallback: false })
} else if (platform === "Windows_NT") {
  const { WindowsToaster } = notifier
  platformNotifier = new WindowsToaster({ withFallback: false })
} else if (platform !== "Darwin") {
  platformNotifier = notifier
}

const lastNotificationTime: Record<string, number> = {}

let lastLinuxNotificationId: number | null = null
let linuxNotifySendSupportsReplace: boolean | null = null

function detectNotifySendCapabilities(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("notify-send", ["--version"], (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      const match = stdout.match(/(\d+)\.(\d+)/)
      if (match) {
        const major = parseInt(match[1], 10)
        const minor = parseInt(match[2], 10)
        resolve(major > 0 || (major === 0 && minor >= 8))
        return
      }
      resolve(false)
    })
  })
}

function sendLinuxNotificationDirect(
  title: string,
  message: string,
  timeout: number,
  iconPath?: string,
  grouping: boolean = true
): Promise<void> {
  return new Promise((resolve) => {
    const args: string[] = []

    args.push("--app-name", "opencode")

    if (iconPath) {
      args.push("--icon", iconPath)
    }

    args.push("--expire-time", String(timeout * 1000))

    if (grouping && lastLinuxNotificationId !== null) {
      args.push("--replace-id", String(lastLinuxNotificationId))
    }

    if (grouping) {
      args.push("--print-id")
    }

    args.push("--", title, message)

    execFile("notify-send", args, (error, stdout) => {
      if (!error && grouping && stdout) {
        const id = parseInt(stdout.trim(), 10)
        if (!isNaN(id)) {
          lastLinuxNotificationId = id
        }
      }
      resolve()
    })
  })
}

function sendLinuxInteractiveNotificationDirect(
  title: string,
  message: string,
  timeout: number,
  iconPath: string | undefined,
  windowId: string,
  paneId: string | null
): Promise<void> {
  return new Promise((resolve) => {
    const args: string[] = ["--app-name", "opencode"]

    if (iconPath) {
      args.push("--icon", iconPath)
    }

    args.push("--expire-time", String(timeout * 1000), "--wait", "--action", "focus=Focus", "--", title, message)

    execFile("notify-send", args, (error, stdout) => {
      if (error || stdout.trim() !== "focus") {
        resolve()
        return
      }

      execFile("niri", ["msg", "action", "focus-window", "--id", windowId], () => {
        if (!paneId) {
          resolve()
          return
        }

        execFile("wezterm", ["cli", "activate-pane", "--pane-id", paneId], () => {
          resolve()
        })
      })
    })
  })
}

function getNiriFocusedWindowId(): string | null {
  if (!process.env.NIRI_SOCKET) return null
  try {
    const output = execFileSync("niri", ["msg", "--json", "focused-window"], {
      timeout: 1000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const data = JSON.parse(output)
    return typeof data?.id === "number" ? String(data.id) : null
  } catch {
    return null
  }
}

const niriInteractiveWindowId: string | null = getNiriFocusedWindowId()
const weztermInteractivePaneId: string | null = process.env.WEZTERM_PANE ?? null

export async function sendNotification(
  title: string,
  message: string,
  timeout: number,
  iconPath?: string,
  notificationSystem: "osascript" | "node-notifier" | "ghostty" = "osascript",
  linuxGrouping: boolean = true,
  linuxInteractive: boolean = false
): Promise<void> {
  const now = Date.now()
  if (lastNotificationTime[message] && now - lastNotificationTime[message] < DEBOUNCE_MS) {
    return
  }
  lastNotificationTime[message] = now

  if (notificationSystem === "ghostty") {
    return new Promise((resolve) => {
      const escapedTitle = title.replace(/[;\x07\x1b\n\r]/g, "")
      const escapedMessage = message.replace(/[;\x07\x1b\n\r]/g, "")
      process.stdout.write(`\x1b]9;${escapedTitle}: ${escapedMessage}\x07`, () => {
        resolve()
      })
    })
  }

  if (platform === "Darwin") {
    if (notificationSystem === "node-notifier") {
      return new Promise((resolve) => {
        const notificationOptions: any = {
          title: title,
          message: message,
          timeout: timeout,
          icon: iconPath,
        }

        notifier.notify(
          notificationOptions,
          () => {
            resolve()
          }
        )
      })
    }

    return new Promise((resolve) => {
      const escapedMessage = message.replace(/"/g, '\\"')
      const escapedTitle = title.replace(/"/g, '\\"')
      exec(
        `osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`,
        () => {
          resolve()
        }
      )
    })
  }

  if (platform === "Linux" || platform.match(/BSD$/)) {
    if (linuxInteractive && niriInteractiveWindowId) {
      return sendLinuxInteractiveNotificationDirect(
        title,
        message,
        timeout,
        iconPath,
        niriInteractiveWindowId,
        weztermInteractivePaneId
      )
    }

    if (linuxGrouping) {
      if (linuxNotifySendSupportsReplace === null) {
        linuxNotifySendSupportsReplace = await detectNotifySendCapabilities()
      }
      if (linuxNotifySendSupportsReplace) {
        return sendLinuxNotificationDirect(title, message, timeout, iconPath, true)
      }
    }
  }

  return new Promise((resolve) => {
    const notificationOptions: any = {
      title: title,
      message: message,
      timeout: timeout,
      icon: iconPath,
      "app-name": "opencode",
    }

    platformNotifier.notify(
      notificationOptions,
      () => {
        resolve()
      }
    )
  })
}
