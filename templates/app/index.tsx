import React, { useState } from 'react';
import { html } from 'react-strict-dom';
import { brandLockup, brandMark } from '../src/brand-image';
import { useNavigation } from '../src/navigation/NavigationProvider';

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

const steps = [
  {
    id: 'routes',
    number: '01',
    title: 'Shape your routes',
    detail: 'Add screens inside app/ and let the file tree define navigation.',
  },
  {
    id: 'interface',
    number: '02',
    title: 'Build the interface',
    detail: 'Use React Strict DOM components across web, iOS, and Android.',
  },
  {
    id: 'ship',
    number: '03',
    title: 'Choose where to ship',
    detail: 'Start on the web, then add either native platform when it matters.',
  },
];

export default function HomePage() {
  const { navigate } = useNavigation();
  const [completed, setCompleted] = useState<string[]>(['routes']);

  function toggleStep(id: string) {
    setCompleted(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
    ));
  }

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
      <html.div
        style={{
          width: '100%',
          maxWidth: 1120,
          alignSelf: 'center',
        } as any}
      >
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
          <html.div style={{ display: 'flex', alignItems: 'center', gap: 12 } as any}>
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
            <html.div>
              <html.div style={{ fontSize: 16, fontWeight: '800' } as any}>
                OnRamp Starter
              </html.div>
            </html.div>
          </html.div>
          <html.div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderRadius: 999,
              backgroundColor: palette.mint,
              color: palette.green,
              padding: '8px 13px',
              fontSize: 13,
              fontWeight: '700',
            } as any}
          >
            <html.span style={{ fontSize: 10 } as any}>●</html.span>
            Ready to customize
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
              Ship one idea everywhere.
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
              OnRamp gives your app a Python backend, a universal React Native
              frontend, and file-based routing.
            </html.p>
            <html.div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 } as any}>
              <html.button
                onClick={() => navigate('/profile/ada')}
                style={{
                  border: 'none',
                  borderRadius: 12,
                  backgroundColor: palette.amber,
                  color: palette.ink,
                  padding: '13px 18px',
                  fontSize: 15,
                  fontWeight: '800',
                  cursor: 'pointer',
                } as any}
              >
                Open a dynamic route →
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
            <html.img
              src={brandLockup}
              alt="OnRamp"
              width={170}
              height={148}
              style={{
                width: 170,
                height: 148,
                maxWidth: '100%',
                objectFit: 'contain',
                marginBottom: 18,
              } as any}
            />
            <html.div style={{ color: palette.muted, fontSize: 13, marginBottom: 8 } as any}>
              Project snapshot
            </html.div>
            <html.h2 style={{ fontSize: 25, margin: 0, marginBottom: 26 } as any}>
              A useful starting line
            </html.h2>
            {[
              ['Frontend', 'Universal'],
              ['Navigation', 'File based'],
              ['Backend', 'Python'],
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
                YOUR LAUNCH CHECKLIST
              </html.div>
              <html.h2 style={{ fontSize: 25, margin: 0, marginTop: 6 } as any}>
                Make the starter yours
              </html.h2>
            </html.div>
            <html.div style={{ color: palette.muted, fontSize: 14 } as any}>
              {completed.length} of {steps.length} complete · tap a step to update
            </html.div>
          </html.div>
          <html.div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 } as any}>
            {steps.map(step => {
              const isComplete = completed.includes(step.id);
              return (
                <html.button
                  key={step.id}
                  onClick={() => toggleStep(step.id)}
                  style={{
                    flex: 1,
                    minWidth: 230,
                    textAlign: 'left',
                    border: `1px solid ${isComplete ? '#B7CBEA' : palette.line}`,
                    borderRadius: 18,
                    backgroundColor: isComplete ? '#F1F5FB' : palette.surface,
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
                      marginBottom: 18,
                    } as any}
                  >
                    <html.span style={{ color: palette.muted, fontSize: 12, fontWeight: '800' } as any}>
                      {step.number}
                    </html.span>
                    <html.span
                      style={{
                        width: 25,
                        height: 25,
                        borderRadius: 999,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isComplete ? palette.green : '#E9EEF7',
                        color: isComplete ? 'white' : palette.muted,
                        fontSize: 12,
                        fontWeight: '900',
                      } as any}
                    >
                      {isComplete ? '✓' : '○'}
                    </html.span>
                  </html.div>
                  <html.div style={{ fontSize: 17, fontWeight: '800', marginBottom: 8 } as any}>
                    {step.title}
                  </html.div>
                  <html.div style={{ color: palette.muted, fontSize: 14, lineHeight: 1.5 } as any}>
                    {step.detail}
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
