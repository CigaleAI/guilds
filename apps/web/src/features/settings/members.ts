import type { OrgRole } from "../../api/types/org";

/** Owners and admins invite, change roles, and remove members. */
export function canManageMembers(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** The roles a viewer may give: owners hand out every role, admins everything but owner. */
export function assignableRoles(viewer: OrgRole): OrgRole[] {
  if (viewer === "owner") return ["owner", "admin", "member"];
  if (viewer === "admin") return ["admin", "member"];
  return [];
}

/** Whether the viewer may change or remove this member: never themselves, and only owners touch owners. */
export function canChangeMember(viewer: OrgRole, target: OrgRole, self: boolean): boolean {
  if (self) return false;
  if (viewer === "owner") return true;
  return viewer === "admin" && target !== "owner";
}

export const roleLabel: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
