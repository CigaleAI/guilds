import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Check,
  LogOut,
  Monitor,
  Moon,
  Music,
  Settings,
  Sun,
  ShieldCheck,
  VolumeX,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef, useState } from "react";
import { switchOrg } from "../../api/identity";
import { useIdentity } from "../../app/identity";
import { useSlots } from "../../app/slots";
import { useStoredFlag } from "../../app/storage";
import { useThemeChoice, type ThemePreference } from "../../app/theme";
import {
  cn,
  Avatar,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  initialsOf,
  personTone,
  toast,
} from "@guildsrun/ui";
import {
  chooseChimeFile,
  chooseDefaultChime,
  maxChimeBytes,
  playChime,
  readChimeSound,
  resumeChimeAudio,
  type ChimeSound,
} from "./chime";
import { messageChimeMutedKey } from "./newMessages";
import { useDesktopNotificationsChoice } from "./desktopNotifications";
const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Match system", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function personInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1
    ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase()
    : initialsOf(name);
}

type AccountTriggerProps = { compact: boolean };

/** What opens the account menu: the operator's avatar, with their name and organisation unless compact. */
function AccountTrigger({ compact }: AccountTriggerProps) {
  const { user, org } = useIdentity();
  return (
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        aria-label={`Account: ${user.name}, ${org.name}`}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-paper data-[state=open]:bg-paper",
          compact ? "p-1" : "w-full px-2 py-1",
        )}
      >
        <Avatar
          name={user.name}
          initials={personInitials(user.name)}
          tone={personTone(user.color) ?? "dusk"}
          size={compact ? 36 : 28}
          round
          {...(user.image ? { src: user.image } : {})}
        />
        {compact ? null : (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{user.name}</span>
            <span className="truncate text-xs text-muted">{org.name}</span>
          </span>
        )}
      </button>
    </DropdownMenu.Trigger>
  );
}

const chimeChoiceCopy = {
  "too-large": {
    title: "That sound is too large",
    description: `Pick a file under ${maxChimeBytes / 1024} KB.`,
  },
  "not-audio": {
    title: "That isn't an audio file",
    description: "Pick a sound the browser can play, such as MP3 or WAV.",
  },
  undecodable: {
    title: "This browser can't play that sound",
    description: "Pick a different audio file.",
  },
  unstored: {
    title: "Couldn't save the chime sound",
    description: "This browser is blocking storage.",
  },
};

async function previewChime(): Promise<void> {
  await resumeChimeAudio();
  playChime();
}

async function chooseChimeSound(file: File, setSound: (sound: ChimeSound) => void): Promise<void> {
  const choice = await chooseChimeFile(file);
  if (choice.kind !== "chosen") {
    toast({ kind: "error", ...chimeChoiceCopy[choice.kind] });
    return;
  }
  setSound(choice.sound);
  await previewChime();
}

async function selectDefaultChime(setSound: (sound: ChimeSound | null) => void): Promise<void> {
  if (chooseDefaultChime() === "unavailable") {
    toast({ kind: "error", ...chimeChoiceCopy.unstored });
    return;
  }
  setSound(null);
  await previewChime();
}

function chimeFilePicked(input: HTMLInputElement, setSound: (sound: ChimeSound) => void): void {
  const file = input.files?.[0];
  input.value = "";
  if (file) void chooseChimeSound(file, setSound);
}

type AccountMenuProps = { compact?: boolean };

/**
 * The signed-in operator: organisation, theme, message chime, chime sound, desktop notifications,
 * settings and sign-out. `compact` shows only the avatar.
 */
export function AccountMenu({ compact = false }: AccountMenuProps) {
  const { user, org, orgs } = useIdentity();
  const { signOut } = useSlots();
  const navigate = useNavigate();
  const platformAdmin = user.platform_admin;
  const [theme, setTheme] = useThemeChoice();
  const notifications = useDesktopNotificationsChoice();
  const [chimeMuted, setChimeMuted] = useStoredFlag(messageChimeMutedKey);
  const [chimeSound, setChimeSound] = useState(readChimeSound);
  const chimeFile = useRef<HTMLInputElement>(null);

  return (
    <>
      <Menu>
        <AccountTrigger compact={compact} />
        <MenuContent side="top" align="start" className="min-w-60">
          {orgs.length > 1 ? (
            <>
              <MenuLabel>Organisation</MenuLabel>
              {orgs.map((candidate) => (
                <MenuItem
                  key={candidate.id}
                  {...(candidate.id === org.id ? { icon: Check } : {})}
                  onSelect={() => candidate.id !== org.id && switchOrg(candidate.id)}
                >
                  {candidate.name}
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          ) : null}
          <MenuLabel>Theme</MenuLabel>
          {themes.map((choice) => (
            <MenuItem
              key={choice.value}
              icon={theme === choice.value ? Check : choice.icon}
              onSelect={() => setTheme(choice.value)}
            >
              {choice.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            role="menuitemcheckbox"
            aria-checked={!chimeMuted}
            icon={chimeMuted ? VolumeX : Check}
            onSelect={() => setChimeMuted(!chimeMuted)}
          >
            Message chime
          </MenuItem>
          <MenuLabel>Chime sound</MenuLabel>
          <MenuItem
            {...(chimeSound === null ? { icon: Check } : {})}
            onSelect={() => void selectDefaultChime(setChimeSound)}
          >
            Default
          </MenuItem>
          {chimeSound ? (
            <MenuItem icon={Check} onSelect={() => void previewChime()}>
              {chimeSound.name}
            </MenuItem>
          ) : null}
          <MenuItem icon={Music} onSelect={() => chimeFile.current?.click()}>
            Choose a file…
          </MenuItem>
          {notifications.supported ? (
            <MenuItem
              icon={notifications.on ? Check : Bell}
              onSelect={() => void notifications.toggle()}
            >
              Desktop notifications
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem icon={Settings} onSelect={() => void navigate({ to: "/settings" })}>
            Settings
          </MenuItem>
          {platformAdmin ? (
            <MenuItem icon={ShieldCheck} onSelect={() => void navigate({ to: "/admin" })}>
              Admin
            </MenuItem>
          ) : null}
          {signOut ? (
            <MenuItem icon={LogOut} onSelect={() => void signOut()}>
              Sign out
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
      <input
        ref={chimeFile}
        type="file"
        accept="audio/*"
        className="hidden"
        aria-label="Chime sound file"
        onChange={(event) => chimeFilePicked(event.currentTarget, setChimeSound)}
      />
    </>
  );
}
