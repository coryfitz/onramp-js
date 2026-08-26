import React, { useState } from 'react';
import { css, html } from 'react-strict-dom';
import { brandMark } from '../../src/brand-image';
import { ScrollScreen } from '../../src/components/ScrollScreen';
import { useNavigation } from '../../src/navigation/NavigationProvider';
import { useCompactLayout } from '../../src/use-compact-layout';

const palette = {
  ink: '#071C47',
  muted: '#66738A',
  canvas: '#F4F7FC',
  surface: '#FFFFFF',
  line: '#DCE4F0',
  green: '#174A96',
  mint: '#E7EFFB',
  amber: '#BFD4FF',
};

const styles = css.create({
  screen: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    backgroundColor: palette.canvas,
    color: palette.ink,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    padding: 20,
  },
  screenCompact: { padding: 16 },
  container: {
    width: '100%',
    maxWidth: 1120,
    boxSizing: 'border-box',
    alignSelf: 'center',
  },
  header: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 28,
  },
  headerCompact: { flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' },
  brandButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: palette.ink,
    padding: 0,
    cursor: 'pointer',
  },
  brandImage: {
    width: 46,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: palette.line,
    objectFit: 'contain',
  },
  brandName: { fontSize: 16, fontWeight: '800' },
  routeBadge: {
    borderRadius: 999,
    backgroundColor: palette.mint,
    color: palette.green,
    paddingBlock: 8,
    paddingInline: 13,
    fontSize: 13,
    fontWeight: '700',
  },
  featureRow: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    marginBottom: 20,
  },
  columnCompact: { flexDirection: 'column', flexWrap: 'nowrap' },
  hero: {
    flex: 2,
    minWidth: 280,
    boxSizing: 'border-box',
    borderRadius: 28,
    backgroundColor: palette.ink,
    color: 'white',
    padding: 36,
    overflow: 'hidden',
  },
  heroCompact: { flex: 0, minWidth: 0, width: '100%', padding: 24 },
  routeLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 22,
    color: '#AFC5E4',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  initial: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: palette.mint,
    color: palette.green,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: '900',
  },
  heroTitle: {
    fontSize: 52,
    lineHeight: '1.02',
    letterSpacing: -2,
    margin: 0,
    marginBottom: 20,
    maxWidth: 620,
  },
  heroTitleCompact: { fontSize: 36, letterSpacing: -1 },
  heroCopy: {
    color: '#C9D6EA',
    fontSize: 17,
    lineHeight: '1.6',
    margin: 0,
    marginBottom: 28,
    maxWidth: 590,
  },
  actionRow: { display: 'flex', flexWrap: 'wrap', gap: 12 },
  primaryButton: {
    borderWidth: 0,
    borderRadius: 12,
    backgroundColor: palette.amber,
    color: palette.ink,
    paddingBlock: 13,
    paddingInline: 18,
    fontSize: 15,
    fontWeight: '800',
    cursor: 'pointer',
  },
  connectedButton: { backgroundColor: palette.mint, color: palette.green },
  secondaryButton: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#35527C',
    borderRadius: 12,
    backgroundColor: 'transparent',
    color: 'white',
    paddingBlock: 13,
    paddingInline: 18,
    fontSize: 15,
    fontWeight: '700',
    cursor: 'pointer',
  },
  snapshot: {
    flex: 1,
    minWidth: 250,
    boxSizing: 'border-box',
    borderRadius: 28,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: palette.line,
    padding: 28,
  },
  fullWidthCompact: { flex: 0, minWidth: 0, width: '100%' },
  eyebrowMuted: { color: palette.muted, fontSize: 13, marginBottom: 8 },
  sectionTitle: { fontSize: 25, margin: 0, marginBottom: 26 },
  snapshotRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    paddingBlock: 14,
    fontSize: 14,
  },
  snapshotBorder: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: palette.line,
  },
  muted: { color: palette.muted },
  strongRight: { fontWeight: '800', textAlign: 'right' },
  routePanel: {
    borderRadius: 28,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: palette.line,
    padding: 28,
  },
  routePanelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  eyebrow: { color: palette.green, fontSize: 12, fontWeight: '800' },
  routePanelTitle: { fontSize: 25, margin: 0, marginTop: 6 },
  routePanelCopy: { color: palette.muted, fontSize: 14 },
  profileRow: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  profileCard: {
    flex: 1,
    minWidth: 190,
    boxSizing: 'border-box',
    textAlign: 'left',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: palette.line,
    borderRadius: 18,
    backgroundColor: palette.surface,
    color: palette.ink,
    padding: 20,
    cursor: 'pointer',
  },
  profileCardCurrent: { borderColor: '#B7CBEA', backgroundColor: '#F1F5FB' },
  profileTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  profileName: { fontSize: 17, fontWeight: '800' },
  profileArrow: { color: palette.muted },
  profileArrowCurrent: { color: palette.green },
  profilePath: { color: palette.muted, fontSize: 13 },
});

const exampleProfiles = [
  { id: 'ada', label: 'Ada' },
  { id: 'grace-hopper', label: 'Grace Hopper' },
  { id: 'new-builder', label: 'New Builder' },
];

function displayName(id?: string) {
  return (id || 'new-builder')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'New Builder';
}

export default function ProfilePage({ id }: { id?: string }) {
  const { navigate } = useNavigation();
  const isCompact = useCompactLayout();
  const [connected, setConnected] = useState(false);
  const profileId = id || 'new-builder';
  const name = displayName(id);

  return (
    <ScrollScreen>
      <html.div style={[styles.screen, isCompact && styles.screenCompact]}>
        <html.div style={styles.container}>
          <html.div style={[styles.header, isCompact && styles.headerCompact]}>
            <html.button onClick={() => navigate('/')} style={styles.brandButton}>
              <html.img
                src={brandMark}
                alt="OnRamp"
                width={46}
                height={46}
                style={styles.brandImage}
              />
              <html.span style={styles.brandName}>OnRamp Starter</html.span>
            </html.button>
            <html.div style={styles.routeBadge}>
              <html.span>Dynamic route · /profile/{profileId}</html.span>
            </html.div>
          </html.div>

          <html.div style={[styles.featureRow, isCompact && styles.columnCompact]}>
            <html.div style={[styles.hero, isCompact && styles.heroCompact]}>
              <html.div style={styles.routeLabel}>
                <html.span style={styles.initial}>{name.charAt(0)}</html.span>
                <html.span>Dynamic file route</html.span>
              </html.div>
              <html.h1 style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                Hello, {name}.
              </html.h1>
              <html.p style={styles.heroCopy}>
                This screen comes from app/profile/[id].tsx. OnRamp reads the URL
                and passes “{profileId}” into the page as a prop.
              </html.p>
              <html.div style={styles.actionRow}>
                <html.button
                  onClick={() => setConnected(current => !current)}
                  style={[styles.primaryButton, connected && styles.connectedButton]}
                >
                  <html.span>{connected ? '✓ Connected' : `Connect with ${name}`}</html.span>
                </html.button>
                <html.button onClick={() => navigate('/')} style={styles.secondaryButton}>
                  <html.span>← Back home</html.span>
                </html.button>
              </html.div>
            </html.div>

            <html.div style={[styles.snapshot, isCompact && styles.fullWidthCompact]}>
              <html.div style={styles.eyebrowMuted}>
                <html.span>Route snapshot</html.span>
              </html.div>
              <html.h2 style={styles.sectionTitle}>The file is the route</html.h2>
              {[
                ['File', 'app/profile/[id].tsx'],
                ['Pattern', '/profile/:id'],
                ['Value', profileId],
                ['Platforms', 'Web + native'],
              ].map(([label, value], index) => (
                <html.div
                  key={label}
                  style={[styles.snapshotRow, index > 0 && styles.snapshotBorder]}
                >
                  <html.span style={styles.muted}>{label}</html.span>
                  <html.span style={styles.strongRight}>{value}</html.span>
                </html.div>
              ))}
            </html.div>
          </html.div>

          <html.div style={styles.routePanel}>
            <html.div style={styles.routePanelHeader}>
              <html.div>
                <html.div style={styles.eyebrow}>
                  <html.span>TRY THE ROUTE</html.span>
                </html.div>
                <html.h2 style={styles.routePanelTitle}>Change the dynamic value</html.h2>
              </html.div>
              <html.div style={styles.routePanelCopy}>
                <html.span>The same file renders every profile</html.span>
              </html.div>
            </html.div>
            <html.div style={[styles.profileRow, isCompact && styles.columnCompact]}>
              {exampleProfiles.map(profile => {
                const isCurrent = profile.id === profileId;
                return (
                  <html.button
                    key={profile.id}
                    onClick={() => navigate(`/profile/${profile.id}`)}
                    style={[
                      styles.profileCard,
                      isCompact && styles.fullWidthCompact,
                      isCurrent && styles.profileCardCurrent,
                    ]}
                  >
                    <html.div style={styles.profileTop}>
                      <html.span style={styles.profileName}>{profile.label}</html.span>
                      <html.span
                        style={[
                          styles.profileArrow,
                          isCurrent && styles.profileArrowCurrent,
                        ]}
                      >
                        {isCurrent ? '●' : '→'}
                      </html.span>
                    </html.div>
                    <html.div style={styles.profilePath}>
                      <html.span>/profile/{profile.id}</html.span>
                    </html.div>
                  </html.button>
                );
              })}
            </html.div>
          </html.div>
        </html.div>
      </html.div>
    </ScrollScreen>
  );
}
