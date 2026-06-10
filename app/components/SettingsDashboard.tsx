'use client';

import { useState } from 'react';
import Settings from './Settings';
import type { User } from '@supabase/supabase-js';
import type { UserSettings } from '@/lib/types';

interface SettingsDashboardProps {
  user: User | null;
  settings: UserSettings;
  followsCount: number;
  onSettingsChange: (newSettings: UserSettings) => Promise<void>;
  onUnfollowAll: () => void;
  onClose: () => void;
}

export default function SettingsDashboard({
  settings,
  followsCount,
  onSettingsChange,
  onUnfollowAll,
}: SettingsDashboardProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'setup' | 'reading' | 'filters' | 'system'>('general');

  // Setup tab (API keys) local state
  const [openaiKey, setOpenaiKey] = useState(settings.apiKeys?.openai || '');
  const [anthropicKey, setAnthropicKey] = useState(settings.apiKeys?.anthropic || '');
  const [savingKeys, setSavingKeys] = useState(false);
  const [keysSaved, setKeysSaved] = useState(false);

  const handleSaveKeys = async () => {
    setSavingKeys(true);
    setKeysSaved(false);
    try {
      await onSettingsChange({
        ...settings,
        apiKeys: {
          ...(settings.apiKeys || {}),
          openai: openaiKey || undefined,
          anthropic: anthropicKey || undefined,
        },
      });
      setKeysSaved(true);
      setTimeout(() => setKeysSaved(false), 2500);
    } finally {
      setSavingKeys(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 md:py-6 min-h-screen">
      {/* Settings Grid */}
      <div className="space-y-4 pb-20 md:pb-0">
        {/* Tab Navigation */}
        <div className="flex space-x-2 border-b mb-6 overflow-x-auto hide-scrollbar" style={{ borderColor: 'var(--color-border)' }}>
          {([
            { id: 'general', label: 'General' },
            { id: 'setup', label: 'Setup' },
            { id: 'reading', label: 'Reading' },
            { id: 'filters', label: 'Filters' },
            { id: 'system', label: 'System' },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2 text-sm transition-colors whitespace-nowrap"
              style={{
                borderBottom: activeTab === tab.id ? '2px solid var(--color-ink)' : '2px solid transparent',
                color: activeTab === tab.id ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                fontWeight: activeTab === tab.id ? 500 : 400,
                marginBottom: '-1px'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Setup Section (API keys) */}
        {activeTab === 'setup' && (
          <section>
            <h2 className="text-lg mb-4" style={{ fontWeight: 400, color: 'var(--color-ink)' }}>
              API keys
            </h2>
            <div className="p-4 rounded-md border" style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)'
            }}>
              <div className="space-y-5">
                <p className="text-sm" style={{ color: 'var(--color-ink-soft)' }}>
                  Keys are stored locally in your database and are only used by your own machine.
                </p>

                {/* OpenAI key */}
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                    OpenAI API key
                  </label>
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    className="w-full px-3 py-2 border rounded-md"
                    style={{
                      borderColor: 'var(--color-border)',
                      backgroundColor: 'var(--color-bg)',
                      color: 'var(--color-ink)',
                      fontSize: '14px'
                    }}
                  />
                  <p className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                    Enables semantic recommendations (For You / Discover) and paper summaries. Papers fetched after you add a key get embedded.
                  </p>
                </div>

                {/* Anthropic key */}
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                    Anthropic API key
                  </label>
                  <input
                    type="password"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    placeholder="sk-ant-..."
                    autoComplete="off"
                    className="w-full px-3 py-2 border rounded-md"
                    style={{
                      borderColor: 'var(--color-border)',
                      backgroundColor: 'var(--color-bg)',
                      color: 'var(--color-ink)',
                      fontSize: '14px'
                    }}
                  />
                  <p className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                    Optional. Enables automatic article-type classification.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveKeys}
                    disabled={savingKeys}
                    className="px-4 py-2 text-sm transition-all rounded-md"
                    style={{
                      backgroundColor: 'var(--color-accent)',
                      color: 'var(--color-accent-text)',
                      fontWeight: 400,
                      opacity: savingKeys ? 0.5 : 1,
                      cursor: savingKeys ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {savingKeys ? 'Saving…' : 'Save'}
                  </button>
                  {keysSaved && (
                    <span className="text-sm" style={{ color: 'var(--color-accent)', fontWeight: 500 }}>
                      Saved
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Preferences Section (Renders Settings.tsx content for general/reading/filters tabs) */}
        {(activeTab === 'general' || activeTab === 'reading' || activeTab === 'filters') && (
          <section>
            <div className="p-4 rounded-md border" style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)'
            }}>
              <Settings
                settings={settings}
                onSettingsChange={onSettingsChange}
                activeTab={activeTab}
              />
            </div>
          </section>
        )}

        {/* Journals Section */}
        {activeTab === 'system' && (
          <section>
            <h2 className="text-base mb-2" style={{ fontWeight: 400, color: 'var(--color-ink)' }}>
              Journals
            </h2>
            <div className="p-4 rounded-md border" style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)'
            }}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base mb-1" style={{ color: 'var(--color-ink)' }}>
                    Following {followsCount} journal{followsCount !== 1 ? 's' : ''}
                  </div>
                  <p className="text-sm" style={{ color: 'var(--color-ink-soft)' }}>
                    Manage your journal subscriptions from the sidebar
                  </p>
                </div>
                <button
                  onClick={onUnfollowAll}
                  disabled={followsCount === 0}
                  className="px-3 py-1.5 text-sm transition-all border rounded-md"
                  style={{
                    backgroundColor: 'var(--color-bg)',
                    color: followsCount === 0 ? 'var(--color-ink-soft)' : '#ef4444',
                    borderColor: followsCount === 0 ? 'var(--color-border)' : 'rgba(239, 68, 68, 0.3)',
                    fontWeight: 400,
                    cursor: followsCount === 0 ? 'not-allowed' : 'pointer',
                    opacity: followsCount === 0 ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (followsCount > 0) {
                      e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (followsCount > 0) {
                      e.currentTarget.style.backgroundColor = 'var(--color-bg)';
                    }
                  }}
                >
                  {followsCount === 0 ? 'No journals to unfollow' : 'Unfollow All'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Keyboard Shortcuts - in System Tab */}
        {activeTab === 'system' && (
          <section>
            <h2 className="text-base mb-2" style={{ fontWeight: 400, color: 'var(--color-ink)' }}>
              Keyboard Shortcuts
            </h2>
            <div className="p-4 rounded-md border" style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)'
            }}>
              <Settings
                settings={settings}
                onSettingsChange={onSettingsChange}
                activeTab="system"
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
