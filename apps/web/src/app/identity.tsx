import { createContext, useContext } from "react";
import type { Identity } from "../api/identity";
import { AppWiringError } from "./wiring";

export const IdentityContext = createContext<Identity | null>(null);

/** The signed-in operator and organisation; available everywhere under the app's boot. */
export function useIdentity(): Identity {
  const identity = useContext(IdentityContext);
  if (!identity) throw new AppWiringError("useIdentity needs the app's IdentityContext");
  return identity;
}
