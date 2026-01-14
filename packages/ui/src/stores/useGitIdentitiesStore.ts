import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { getSafeStorage } from "./utils/safeStorage";
import {
  getGitIdentities,
  createGitIdentity,
  updateGitIdentity,
  deleteGitIdentity,
  discoverGitCredentials,
  getGlobalGitIdentity
} from "@/lib/gitApi";
import { getDesktopSettings, updateDesktopSettings, isDesktopRuntime } from "@/lib/desktop";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
  isDefault?: boolean;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

interface GitIdentitiesStore {

  selectedProfileId: string | null;
  defaultProfileId: string | null; // 'global' for system identity, profile id for custom, null for none
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null;
  discoveredCredentials: DiscoveredGitCredential[];
  isLoading: boolean;

  setSelectedProfile: (id: string | null) => void;
  loadProfiles: () => Promise<boolean>;
  loadGlobalIdentity: () => Promise<boolean>;
  loadDefaultProfileId: () => Promise<boolean>;
  loadDiscoveredCredentials: () => Promise<boolean>;
  createProfile: (profile: Omit<GitIdentityProfile, 'id'> & { id?: string }) => Promise<boolean>;
  updateProfile: (id: string, updates: Partial<GitIdentityProfile>) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  getProfileById: (id: string) => GitIdentityProfile | undefined;
  getDefaultProfile: () => GitIdentityProfile | undefined;
  setDefaultProfile: (id: string | null) => Promise<boolean>;
  clearDefaultProfile: () => Promise<boolean>;
  getUnimportedCredentials: () => DiscoveredGitCredential[];
}

declare global {
  interface Window {
    __zustand_git_identities_store__?: UseBoundStore<StoreApi<GitIdentitiesStore>>;
  }
}

export const useGitIdentitiesStore = create<GitIdentitiesStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedProfileId: null,
        defaultProfileId: 'global', // Default to global identity initially
        profiles: [],
        globalIdentity: null,
        discoveredCredentials: [],
        isLoading: false,

        setSelectedProfile: (id: string | null) => {
          set({ selectedProfileId: id });
        },

        loadProfiles: async () => {
          set({ isLoading: true });
          const previousProfiles = get().profiles;

          try {
            const profiles = await getGitIdentities();
            set({ profiles, isLoading: false });
            return true;
          } catch (error) {
            console.error("Failed to load git identity profiles:", error);
            set({ profiles: previousProfiles, isLoading: false });
            return false;
          }
        },

        loadGlobalIdentity: async () => {
          try {
            const data = await getGlobalGitIdentity();

            if (data && data.userName && data.userEmail) {
              const globalProfile: GitIdentityProfile = {
                id: 'global',
                name: 'Global Identity',
                userName: data.userName,
                userEmail: data.userEmail,
                authType: data.sshCommand ? 'ssh' : undefined,
                sshKey: data.sshCommand ? data.sshCommand.replace('ssh -i ', '') : null,
                color: 'info',
                icon: 'house'
              };
              set({ globalIdentity: globalProfile });
            } else {
              set({ globalIdentity: null });
            }

            return true;
          } catch (error) {
            console.error("Failed to load global git identity:", error);
            set({ globalIdentity: null });
            return false;
          }
        },

        loadDefaultProfileId: async () => {
          try {
            let defaultId: string | null = null;

            // 1. Desktop runtime (Tauri)
            if (isDesktopRuntime()) {
              const settings = await getDesktopSettings();
              defaultId = settings?.defaultGitIdentityId ?? null;
            } else {
              // 2. Runtime settings API (VSCode)
              const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
              if (runtimeSettings) {
                try {
                  const result = await runtimeSettings.load();
                  const settings = result?.settings;
                  if (settings && typeof settings.defaultGitIdentityId === 'string') {
                    defaultId = settings.defaultGitIdentityId;
                  }
                } catch {
                  // Fall through to fetch
                }
              }

              // 3. Fetch API (Web)
              if (defaultId === null) {
                try {
                  const response = await fetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                  });
                  if (response.ok) {
                    const data = await response.json();
                    defaultId = data.defaultGitIdentityId ?? null;
                  }
                } catch {
                  // Ignore fetch errors
                }
              }
            }

            // Default to 'global' if not set
            set({ defaultProfileId: defaultId ?? 'global' });
            return true;
          } catch (error) {
            console.error("Failed to load default git identity id:", error);
            return false;
          }
        },

        loadDiscoveredCredentials: async () => {
          try {
            const credentials = await discoverGitCredentials();
            set({ discoveredCredentials: credentials });
            return true;
          } catch (error) {
            console.error("Failed to discover git credentials:", error);
            set({ discoveredCredentials: [] });
            return false;
          }
        },

        createProfile: async (profileData) => {
          try {

            const profile = {
              ...profileData,
              id: profileData.id || `profile-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
              color: profileData.color || 'keyword',
              icon: profileData.icon || 'branch'
            };

            await createGitIdentity(profile);

            await get().loadProfiles();

            // If this profile is marked as default, update the default setting
            if (profile.isDefault) {
              await get().setDefaultProfile(profile.id);
            }

            return true;
          } catch (error) {
            console.error("Failed to create git identity profile:", error);
            return false;
          }
        },

        updateProfile: async (id, updates) => {
          try {

            const existing = get().profiles.find(p => p.id === id);
            if (!existing) {
              throw new Error("Profile not found");
            }

            const updated = { ...existing, ...updates };
            await updateGitIdentity(id, updated);

            await get().loadProfiles();

            // Handle default setting changes
            if (updates.isDefault === true) {
              // This profile is now set as default
              await get().setDefaultProfile(id);
            } else if (updates.isDefault === false && get().defaultProfileId === id) {
              // This profile was default but is no longer - revert to global
              await get().setDefaultProfile('global');
            }

            return true;
          } catch (error) {
            console.error("Failed to update git identity profile:", error);
            return false;
          }
        },

        deleteProfile: async (id) => {
          try {
            await deleteGitIdentity(id);

            if (get().selectedProfileId === id) {
              set({ selectedProfileId: null });
            }

            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to delete git identity profile:", error);
            return false;
          }
        },

        getProfileById: (id) => {
          const { profiles, globalIdentity } = get();
          if (id === 'global') {
            return globalIdentity || undefined;
          }
          return profiles.find((p) => p.id === id);
        },

        getDefaultProfile: () => {
          const { profiles, globalIdentity, defaultProfileId } = get();

          // If defaultProfileId is set, use it
          if (defaultProfileId === 'global') {
            return globalIdentity || undefined;
          }

          if (defaultProfileId) {
            const profile = profiles.find((p) => p.id === defaultProfileId);
            if (profile) return profile;
          }

          // Fallback: check if any profile has isDefault flag from backend
          const backendDefault = profiles.find((p) => p.isDefault === true);
          if (backendDefault) return backendDefault;

          // Final fallback: return global identity if available
          return globalIdentity || undefined;
        },

        setDefaultProfile: async (id) => {
          try {
            if (id === null) {
              // Clear default - delegate to clearDefaultProfile
              return get().clearDefaultProfile();
            }

            if (id === 'global') {
              // Setting global as default - clear isDefault on any custom profiles
              const { profiles } = get();
              for (const profile of profiles) {
                if (profile.isDefault) {
                  await updateGitIdentity(profile.id, { ...profile, isDefault: false });
                }
              }
            } else {
              const profile = get().profiles.find(p => p.id === id);
              if (!profile) {
                throw new Error("Profile not found");
              }
              // Setting isDefault to true will automatically unset other defaults on the backend
              await updateGitIdentity(id, { ...profile, isDefault: true });
            }

            // Save to desktop settings
            await updateDesktopSettings({ defaultGitIdentityId: id });

            set({ defaultProfileId: id });
            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to set default git identity profile:", error);
            return false;
          }
        },

        clearDefaultProfile: async () => {
          try {
            const { profiles } = get();
            // Clear isDefault on any custom profiles
            for (const profile of profiles) {
              if (profile.isDefault) {
                await updateGitIdentity(profile.id, { ...profile, isDefault: false });
              }
            }

            // Save to desktop settings (empty string to clear)
            await updateDesktopSettings({ defaultGitIdentityId: '' });

            set({ defaultProfileId: null });
            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to clear default git identity profile:", error);
            return false;
          }
        },

        getUnimportedCredentials: () => {
          const { profiles, discoveredCredentials } = get();
          // Filter out credentials that have already been imported as token-based profiles
          return discoveredCredentials.filter(cred => {
            return !profiles.some(p =>
              p.authType === 'token' && p.host === cred.host
            );
          });
        },
      }),
      {
        name: "git-identities-store",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          selectedProfileId: state.selectedProfileId,
          // defaultProfileId is now stored in desktop settings, not localStorage
        }),
      },
    ),
    {
      name: "git-identities-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_git_identities_store__ = useGitIdentitiesStore;
}
