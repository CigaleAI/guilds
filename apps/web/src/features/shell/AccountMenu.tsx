import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, LogOut, Monitor, Moon, Settings, Sun, ShieldCheck } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { switchOrg } from "../../api/identity";
import { useIdentity } from "../../app/identity";
import { useSlots } from "../../app/slots";
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
} from "@guildsrun/ui";
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

type AccountMenuProps = { compact?: boolean };

/**
 * The signed-in operator: organisation, theme, desktop notifications, settings and sign-out.
 * `compact` shows only the avatar.
 */
export function AccountMenu({ compact = false }: AccountMenuProps) {
  const { user, org, orgs } = useIdentity();
  const { signOut } = useSlots();
  const navigate = useNavigate();
  const platformAdmin = user.platform_admin;
  const [theme, setTheme] = useThemeChoice();
  const notifications = useDesktopNotificationsChoice();
  const avatar = (
    <Avatar
      name={user.name}
      initials={personInitials(user.name)}
      tone={personTone(user.color) ?? "dusk"}
      size={compact ? 36 : 28}
      round
      {...(user.image ? { src: user.image } : {})}
    />
  );

  return (
    <Menu>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Account: ${user.name}, ${org.name}`}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-paper data-[state=open]:bg-paper",
            compact ? "p-1" : "w-full px-2 py-1",
          )}
        >
          {avatar}
          {compact ? null : (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">{user.name}</span>
              <span className="truncate text-xs text-muted">{org.name}</span>
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
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
        {notifications.supported ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon={notifications.on ? Check : Bell}
              onSelect={() => void notifications.toggle()}
            >
              Desktop notifications
            </MenuItem>
          </>
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
  );
}
