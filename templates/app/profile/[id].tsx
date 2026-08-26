import React, { useState } from 'react';
import { html } from 'react-strict-dom';
import { brandMark } from '../../src/brand-image';
import { useNavigation } from '../../src/navigation/NavigationProvider';

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
  const [connected, setConnected] = useState(false);
  const profileId = id || 'new-builder';
  const name = displayName(id);

  return (
    <html.div
      style={{
        minHeight: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        backgroundColor: palette.canvas,
        color: palette.ink,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        padding: 20,
      } as any}
    >
      <html.div style={{ width: '100%', maxWidth: 1120, alignSelf: 'center' } as any}>
        <html.div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
            marginBottom: 28,
          } as any}
        >
          <html.button
            onClick={() => navigate('/')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: 'none',
              backgroundColor: 'transparent',
              color: palette.ink,
              padding: 0,
              cursor: 'pointer',
            } as any}
          >
            <html.img
              src={brandMark}
              alt="OnRamp"
              width={46}
              height={46}
              style={{
                width: 46,
                height: 46,
                borderRadius: 14,
                border: `1px solid ${palette.line}`,
                objectFit: 'contain',
              } as any}
            />
            <html.span style={{ fontSize: 16, fontWeight: '800' } as any}>
              OnRamp Starter
            </html.span>
          </html.button>
          <html.div
            style={{
              borderRadius: 999,
              backgroundColor: palette.mint,
              color: palette.green,
              padding: '8px 13px',
              fontSize: 13,
              fontWeight: '700',
            } as any}
          >
            <html.span>Dynamic route · /profile/{profileId}</html.span>
          </html.div>
        </html.div>

        <html.div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 20,
            marginBottom: 20,
          } as any}
        >
          <html.div
            style={{
              flex: 2,
              minWidth: 280,
              borderRadius: 28,
              backgroundColor: palette.ink,
              color: 'white',
              padding: 36,
              overflow: 'hidden',
            } as any}
          >
            <html.div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 22,
                color: '#AFC5E4',
                fontSize: 12,
                fontWeight: '800',
                letterSpacing: 1.2,
                textTransform: 'uppercase',
              } as any}
            >
              <html.span
                style={{
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
                } as any}
              >
                {name.charAt(0)}
              </html.span>
              <html.span>Dynamic file route</html.span>
            </html.div>
            <html.h1
              style={{
                fontSize: 52,
                lineHeight: 1.02,
                letterSpacing: -2,
                margin: 0,
                marginBottom: 20,
                maxWidth: 620,
              } as any}
            >
              Hello, {name}.
            </html.h1>
            <html.p
              style={{
                color: '#C9D6EA',
                fontSize: 17,
                lineHeight: 1.6,
                margin: 0,
                marginBottom: 28,
                maxWidth: 590,
              } as any}
            >
              This screen comes from app/profile/[id].tsx. OnRamp reads the URL
              and passes “{profileId}” into the page as a prop.
            </html.p>
            <html.div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 } as any}>
              <html.button
                onClick={() => setConnected(current => !current)}
                style={{
                  border: 'none',
                  borderRadius: 12,
                  backgroundColor: connected ? palette.mint : palette.amber,
                  color: connected ? palette.green : palette.ink,
                  padding: '13px 18px',
                  fontSize: 15,
                  fontWeight: '800',
                  cursor: 'pointer',
                } as any}
              >
                {connected ? '✓ Connected' : `Connect with ${name}`}
              </html.button>
              <html.button
                onClick={() => navigate('/')}
                style={{
                  border: '1px solid #35527C',
                  borderRadius: 12,
                  backgroundColor: 'transparent',
                  color: 'white',
                  padding: '13px 18px',
                  fontSize: 15,
                  fontWeight: '700',
                  cursor: 'pointer',
                } as any}
              >
                ← Back home
              </html.button>
            </html.div>
          </html.div>

          <html.div
            style={{
              flex: 1,
              minWidth: 250,
              borderRadius: 28,
              backgroundColor: palette.surface,
              border: `1px solid ${palette.line}`,
              padding: 28,
            } as any}
          >
            <html.div style={{ color: palette.muted, fontSize: 13, marginBottom: 8 } as any}>
              Route snapshot
            </html.div>
            <html.h2 style={{ fontSize: 25, margin: 0, marginBottom: 26 } as any}>
              The file is the route
            </html.h2>
            {[
              ['File', 'app/profile/[id].tsx'],
              ['Pattern', '/profile/:id'],
              ['Value', profileId],
              ['Platforms', 'Web + native'],
            ].map(([label, value], index) => (
              <html.div
                key={label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingTop: 14,
                  paddingBottom: 14,
                  borderTop: index === 0 ? 'none' : `1px solid ${palette.line}`,
                  fontSize: 14,
                } as any}
              >
                <html.span style={{ color: palette.muted } as any}>{label}</html.span>
                <html.span style={{ fontWeight: '800', textAlign: 'right' } as any}>
                  {value}
                </html.span>
              </html.div>
            ))}
          </html.div>
        </html.div>

        <html.div
          style={{
            borderRadius: 28,
            backgroundColor: palette.surface,
            border: `1px solid ${palette.line}`,
            padding: 28,
          } as any}
        >
          <html.div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 20,
            } as any}
          >
            <html.div>
              <html.div style={{ color: palette.green, fontSize: 12, fontWeight: '800' } as any}>
                TRY THE ROUTE
              </html.div>
              <html.h2 style={{ fontSize: 25, margin: 0, marginTop: 6 } as any}>
                Change the dynamic value
              </html.h2>
            </html.div>
            <html.div style={{ color: palette.muted, fontSize: 14 } as any}>
              The same file renders every profile
            </html.div>
          </html.div>
          <html.div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 } as any}>
            {exampleProfiles.map(profile => {
              const isCurrent = profile.id === profileId;
              return (
                <html.button
                  key={profile.id}
                  onClick={() => navigate(`/profile/${profile.id}`)}
                  style={{
                    flex: 1,
                    minWidth: 190,
                    textAlign: 'left',
                    border: `1px solid ${isCurrent ? '#B7CBEA' : palette.line}`,
                    borderRadius: 18,
                    backgroundColor: isCurrent ? '#F1F5FB' : palette.surface,
                    color: palette.ink,
                    padding: 20,
                    cursor: 'pointer',
                  } as any}
                >
                  <html.div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 12,
                    } as any}
                  >
                    <html.span style={{ fontSize: 17, fontWeight: '800' } as any}>
                      {profile.label}
                    </html.span>
                    <html.span style={{ color: isCurrent ? palette.green : palette.muted } as any}>
                      {isCurrent ? '●' : '→'}
                    </html.span>
                  </html.div>
                  <html.div style={{ color: palette.muted, fontSize: 13 } as any}>
                    <html.span>/profile/{profile.id}</html.span>
                  </html.div>
                </html.button>
              );
            })}
          </html.div>
        </html.div>
      </html.div>
    </html.div>
  );
}
