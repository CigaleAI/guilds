import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { loadIdentity } from "../api/identity";
import { Button, PageError, SkeletonRows, Toaster, TooltipProvider } from "@guildsrun/ui";
import { IdentityContext } from "./identity";
import { router } from "./router";
import { SlotsContext, type AppSlots } from "./slots";
import { ThemeContext, useTheme } from "./theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
  },
});

/** Resolves who is signed in before any page renders. */
function Boot() {
  const identity = useQuery({
    queryKey: ["identity"],
    queryFn: loadIdentity,
    staleTime: Infinity,
    retry: false,
  });
  if (identity.isPending) {
    return (
      <div className="grid h-dvh place-items-center bg-page">
        <SkeletonRows rows={3} label="Signing in" className="w-80" />
      </div>
    );
  }
  if (identity.isError) {
    return (
      <div className="grid h-dvh place-items-center bg-page p-6">
        <PageError
          title="Couldn't reach guilds.run"
          description={identity.error.message}
          action={<Button onClick={() => void identity.refetch()}>Try again</Button>}
        />
      </div>
    );
  }
  return (
    <IdentityContext value={identity.data}>
      <RouterProvider router={router} />
    </IdentityContext>
  );
}

type AppProps = { slots?: AppSlots };

/** The app, with what the extension adds; a path the extension owns is shown before anyone is identified. */
export function App({ slots = {} }: AppProps) {
  const theme = useTheme();
  return (
    <ThemeContext value={theme}>
      <QueryClientProvider client={queryClient}>
        <SlotsContext value={slots}>
          <TooltipProvider>
            {slots.publicPage?.(window.location.pathname) ?? <Boot />}
            <Toaster />
          </TooltipProvider>
        </SlotsContext>
      </QueryClientProvider>
    </ThemeContext>
  );
}
