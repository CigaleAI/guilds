import { useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useAdminCatalog } from "../../api/queries/admin";
import { useIdentity } from "../../app/identity";
import { chosenTab, placeTabs, useSlots } from "../../app/slots";
import { EmptyState, Segmented } from "@guildsrun/ui";
import { CatalogTab } from "./CatalogTab";
import { InstanceTab } from "./InstanceTab";
import { UsersTab } from "./UsersTab";

const coreTabs = [
  { value: "catalog", label: "Connector catalog" },
  { value: "instance", label: "Platform keys" },
];

/** The user directory's tab, on the modes whose server serves one. */
const usersTab = { value: "users", label: "Users" };

/** Platform administration: the connector catalog, the platform's keys, the users, and the tabs an extension adds. */
export function AdminPage() {
  const search = useSearch({ from: "/admin" });
  const navigate = useNavigate();
  const catalog = useAdminCatalog();
  const { adminTabs = [] } = useSlots();
  const { mode } = useIdentity();
  const directory = mode === "compat-cookie" || mode === "trusted-header";
  const tabs = placeTabs(directory ? [...coreTabs, usersTab] : coreTabs, adminTabs);
  const tab = chosenTab(tabs, search.tab);
  const added = adminTabs.find((item) => item.id === tab);

  if (catalog.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={ShieldOff}
          title="Platform admins only"
          description="This page is for the platform's admins."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-line px-6 pt-8 pb-4 md:px-10">
        <div className="flex flex-col gap-1">
          <span className="type-label text-muted">Platform</span>
          <h1 className="type-h1">Admin</h1>
        </div>
        <Segmented
          size="sm"
          label="Admin section"
          value={tab}
          onValueChange={(next) =>
            void navigate({ to: "/admin", search: next === "catalog" ? {} : { tab: next } })
          }
          options={tabs}
        />
      </header>
      {added ? (
        added.render()
      ) : tab === "instance" ? (
        <InstanceTab />
      ) : tab === "users" ? (
        <UsersTab />
      ) : (
        <CatalogTab servers={catalog.data?.servers} />
      )}
    </div>
  );
}
