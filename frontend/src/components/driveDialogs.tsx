import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { api, type WebDavStatus } from "../api";
import { DRIVE_NAME, formatDate, PASSWORD_MIN } from "../format";
import { Button, Dialog, DialogActions, ErrorNote, Field, useSubmit } from "./ui";

export function checkNewPassword(password: string, repeat: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the password.`;
  if (password !== repeat) return "The two passwords don't match.";
  return null;
}

/** "New password" and "Repeat" fields. */
export function NewPasswordFields({
  label = "Password",
  hint,
  password,
  repeat,
  onPassword,
  onRepeat,
  autoFocus = false,
}: {
  label?: string;
  hint?: string;
  password: string;
  repeat: string;
  onPassword: (v: string) => void;
  onRepeat: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Field
        label={label}
        type="password"
        autoComplete="new-password"
        autoFocus={autoFocus}
        required
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        hint={hint}
      />
      <Field
        label={`Repeat ${label.toLowerCase()}`}
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        onChange={(e) => onRepeat(e.target.value)}
      />
    </>
  );
}

export function UnlockDialog({
  drive,
  onClose,
  onUnlocked,
}: {
  drive: string;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "password") {
      void run(async () => {
        await api.unlock(drive, password);
        onUnlocked();
      });
      return;
    }
    const problem = checkNewPassword(newPassword, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      await api.recover(drive, recoveryKey.trim(), newPassword);
      onUnlocked();
    });
  }

  return (
    <Dialog title={mode === "password" ? `Unlock ${drive}` : `Reset the password for ${drive}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {mode === "password" ? (
          <Field
            label="Drive password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <>
            <Field
              label="Recovery key"
              autoComplete="off"
              autoFocus
              required
              spellCheck={false}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              hint="The key shown when this drive got its password."
            />
            <NewPasswordFields
              label="New password"
              password={newPassword}
              repeat={repeat}
              onPassword={setNewPassword}
              onRepeat={setRepeat}
            />
          </>
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <button
            type="button"
            className="mr-auto text-sm text-teal underline underline-offset-2"
            onClick={() => {
              setError(null);
              setMode(mode === "password" ? "recovery" : "password");
            }}
          >
            {mode === "password" ? "Forgot the password?" : "Use the password instead"}
          </button>
          <Button variant="primary" type="submit" disabled={busy}>
            {mode === "password" ? (busy ? "Unlocking…" : "Unlock") : busy ? "Resetting…" : "Reset password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function CreateDriveDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string, recoveryKey: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!DRIVE_NAME.test(trimmed) || trimmed.length > 64) {
      return setError("Drive names start with a letter or number and use only letters, numbers, spaces, . _ and -");
    }
    if (protect) {
      const problem = checkNewPassword(password, repeat);
      if (problem) return setError(problem);
    }
    void run(async () => {
      const created = await api.createDrive(trimmed, protect ? password : null);
      onCreated(created.name, created.recovery_key);
    });
  }

  return (
    <Dialog title="Create a drive" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={protect}
            onChange={(e) => setProtect(e.target.checked)}
          />
          <span>
            <span className="font-medium">Protect with its own password</span>
            <span className="block text-muted">
              {protect
                ? "Opening this drive will need the master password and this one."
                : "Without one, the drive opens as soon as the master password is entered."}
            </span>
          </span>
        </label>
        {protect && (
          <NewPasswordFields
            label="Drive password"
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
          />
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create drive"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function RenameDriveDialog({
  drive,
  onClose,
  onRenamed,
}: {
  drive: string;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(drive);
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!DRIVE_NAME.test(trimmed) || trimmed.length > 64) {
      return setError("Drive names start with a letter or number and use only letters, numbers, spaces, . _ and -");
    }
    if (trimmed === drive) return onClose();
    void run(async () => {
      const renamed = await api.renameDrive(drive, trimmed);
      onRenamed(renamed.name);
    });
  }

  return (
    <Dialog title={`Rename ${drive}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="New name"
          autoFocus
          required
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          hint="Only the name changes. Passwords, recovery keys and files stay as they are."
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Shows a recovery key exactly once. The only way out is to confirm it has been saved. */
/** Copies `text`, and says so for a moment. */
export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      className={className}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function RecoveryKeyDialog({
  title,
  recoveryKey,
  action,
  onDone,
  children,
}: {
  title: string;
  recoveryKey: string;
  action: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const [saved, setSaved] = useState(false);

  return (
    <Dialog title={title} onClose={() => saved && onDone()}>
      <p className="text-sm text-muted">{children} It is shown once and is not stored anywhere.</p>
      <div className="mt-4 rounded-md border border-brass/50 bg-brass/10 p-4">
        <p className="select-all break-words text-lg font-medium leading-relaxed tracking-wide">{recoveryKey}</p>
      </div>
      <CopyButton text={recoveryKey} label="Copy key" className="mt-3" />
      <label className="mt-5 flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I have saved this key somewhere safe.
      </label>
      <DialogActions>
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export type PasswordAction = "add" | "change" | "remove";

const PASSWORD_TITLES: Record<PasswordAction, string> = {
  add: "Add a password to",
  change: "Change the password for",
  remove: "Remove the password from",
};

/** Only the drive key is re-wrapped, so this is instant whatever the drive holds. */
export function DrivePasswordDialog({
  drive,
  action,
  onClose,
  onDone,
}: {
  drive: string;
  action: PasswordAction;
  onClose: () => void;
  onDone: (recoveryKey: string | null) => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (action !== "remove") {
      const problem = checkNewPassword(password, repeat);
      if (problem) return setError(problem);
    }
    void run(async () => {
      const result = await api.setDrivePassword(
        drive,
        action === "add" ? null : current,
        action === "remove" ? null : password,
      );
      onDone(result.recovery_key);
    });
  }

  return (
    <Dialog title={`${PASSWORD_TITLES[action]} ${drive}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {action === "add" && (
          <p className="text-sm text-muted">
            Opening {drive} will then need the master password and this one. You'll get a recovery key for it.
          </p>
        )}
        {action === "remove" && (
          <p className="text-sm text-muted">
            {drive} will open with the master password alone, and its recovery key will stop working.
          </p>
        )}
        {action !== "add" && (
          <Field
            label="Current drive password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        {action !== "remove" && (
          <NewPasswordFields
            label="New password"
            autoFocus={action === "add"}
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
          />
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={action === "remove" ? "danger" : "primary"} type="submit" disabled={busy}>
            {busy ? "Saving…" : action === "remove" ? "Remove password" : "Save password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function MasterPasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const problem = checkNewPassword(password, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      await api.changeVaultPassword(current, password);
      setDone(true);
    });
  }

  if (done) {
    return (
      <Dialog title="Master password changed" onClose={onClose}>
        <p className="text-sm text-muted">
          Use the new password next time. Your master recovery key still works, and no drive was changed.
        </p>
        <DialogActions>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog title="Change the master password" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Current master password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <NewPasswordFields
          label="New password"
          password={password}
          repeat={repeat}
          onPassword={setPassword}
          onRepeat={setRepeat}
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function DeleteDriveDialog({
  drive,
  isProtected,
  onClose,
  onDeleted,
}: {
  drive: string;
  isProtected: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api.deleteDrive(drive, password);
      onDeleted();
    });
  }

  return (
    <Dialog title={`Delete ${drive}?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          This deletes the drive and every file in it, including the copies in your Telegram channel. It can't be
          undone.
        </p>
        <Field
          label={isProtected ? "Drive password" : "Master password"}
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" type="submit" disabled={busy}>
            {busy ? "Deleting…" : "Delete drive"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-surface px-3 py-2 text-sm"
        >
          {value}
        </code>
        <CopyButton text={value} label="Copy" className="shrink-0" />
      </div>
    </div>
  );
}

/** Mounting a drive as a network drive. The WebDAV password is made by the
 * server, shown once, and opens this drive by itself, so turning it on is
 * confirmed with a password; turning it off is not. */
export function WebDavDialog({
  drive,
  isProtected,
  onClose,
  onChanged,
}: {
  drive: string;
  isProtected: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["webdav", drive], queryFn: () => api.webdav(drive) });
  const [confirming, setConfirming] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();

  const address = status.data ? `${location.origin}${status.data.path}` : "";
  // Basic auth sends the password with every request; only HTTPS keeps it off the wire.
  const insecure = location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  function changed(next: WebDavStatus) {
    queryClient.setQueryData(["webdav", drive], next);
    onChanged();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const { password: issuedPassword, ...next } = await api.enableWebdav(drive, password, readOnly);
      changed(next);
      setIssued(issuedPassword);
      setConfirming(false);
      setPassword("");
    });
  }

  if (issued && status.data) {
    return (
      <Dialog title={`WebDAV for ${drive}`} onClose={() => saved && onClose()}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Add a network drive (WebDAV) in your file manager with these details. The password is shown once and is not
            stored anywhere.
          </p>
          <CopyRow label="Address" value={address} />
          <CopyRow label="User name" value={drive} />
          <div>
            <p className="text-sm font-medium">Password</p>
            <div className="mt-1.5 rounded-md border border-brass/50 bg-brass/10 p-4">
              <p className="select-all break-words text-lg font-medium leading-relaxed tracking-wide">{issued}</p>
            </div>
            <CopyButton text={issued} label="Copy password" className="mt-3" />
          </div>
          <p className="text-xs text-muted">Any user name works; the password is what counts.</p>
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            I have saved this password.
          </label>
        </div>
        <DialogActions>
          <Button variant="primary" disabled={!saved} onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  const enabled = status.data?.enabled ?? false;
  return (
    <Dialog title={`WebDAV for ${drive}`} onClose={onClose}>
      {status.isPending && <p className="text-sm text-muted">Loading…</p>}
      {status.error && <ErrorNote>{status.error.message}</ErrorNote>}
      {status.data && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            WebDAV lets you open this drive as a network drive in Windows Explorer, macOS Finder, Linux file managers or
            apps like rclone, without the browser.
          </p>
          {insecure && (
            <p className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              This page is on plain HTTP, so the WebDAV password would cross the network readable by anyone on the
              way. Serve tgdrive over HTTPS before using it.
            </p>
          )}

          {enabled && !confirming && (
            <>
              <CopyRow label="Address" value={address} />
              <p className="text-sm">
                {status.data.read_only ? "Read-only" : "Read and write"}
                {status.data.created_at !== null && (
                  <span className="text-muted"> · password made {formatDate(status.data.created_at)}</span>
                )}
              </p>
              <p className="text-sm text-muted">
                The password was shown when it was made. If it is lost, make a new one; the old one stops working.
              </p>
              <ErrorNote>{error}</ErrorNote>
              <DialogActions>
                <Button
                  variant="danger"
                  disabled={busy}
                  className="mr-auto"
                  onClick={() =>
                    void run(async () => {
                      await api.disableWebdav(drive);
                      changed({ ...status.data, enabled: false, created_at: null });
                    })
                  }
                >
                  {busy ? "Turning off…" : "Turn off"}
                </Button>
                <Button
                  onClick={() => {
                    setReadOnly(status.data.read_only);
                    setConfirming(true);
                  }}
                >
                  New password
                </Button>
              </DialogActions>
            </>
          )}

          {(!enabled || confirming) && (
            <form onSubmit={submit} className="space-y-4">
              <p className="rounded-md border border-brass/50 bg-brass/10 px-3 py-2 text-sm">
                Anyone with the WebDAV password can open this drive without the master password, even while tgdrive is
                locked. Turn it off here at any time.
              </p>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                />
                <span>
                  Read-only
                  <span className="block text-muted">Files can be opened and copied out, but not changed.</span>
                </span>
              </label>
              <Field
                label={isProtected ? "Drive password" : "Master password"}
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint="To confirm it's you."
              />
              <ErrorNote>{error}</ErrorNote>
              <DialogActions>
                <Button onClick={confirming ? () => setConfirming(false) : onClose}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? "Working…" : confirming ? "Make new password" : "Turn on WebDAV"}
                </Button>
              </DialogActions>
            </form>
          )}
        </div>
      )}
    </Dialog>
  );
}
