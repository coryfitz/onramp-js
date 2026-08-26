import React, { useState } from 'react';
import { css, html } from 'react-strict-dom';
import { brandLockup, brandMark } from '../src/brand-image';
import { ScrollScreen } from '../src/components/ScrollScreen';
import { useNavigation } from '../src/navigation/NavigationProvider';
import { useCompactLayout } from '../src/use-compact-layout';

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
  columnCompact: { flexDirection: 'column', flexWrap: 'nowrap' },
  brand: { display: 'flex', alignItems: 'center', gap: 12 },
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
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    backgroundColor: palette.mint,
    color: palette.green,
    paddingBlock: 8,
    paddingInline: 13,
    fontSize: 13,
    fontWeight: '700',
  },
  statusDot: { fontSize: 10 },
  featureRow: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    marginBottom: 20,
  },
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
  lockup: { width: 170, height: 148, objectFit: 'contain', marginBottom: 18 },
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
  checklist: {
    borderRadius: 28,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: palette.line,
    padding: 28,
  },
  checklistHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  eyebrow: { color: palette.green, fontSize: 12, fontWeight: '800' },
  checklistTitle: { fontSize: 25, margin: 0, marginTop: 6 },
  progress: { color: palette.muted, fontSize: 14 },
  stepRow: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stepCard: {
    flex: 1,
    minWidth: 230,
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
  stepCardComplete: { borderColor: '#B7CBEA', backgroundColor: '#F1F5FB' },
  stepTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  stepNumber: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  stepCheck: {
    width: 25,
    height: 25,
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E9EEF7',
    color: palette.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  stepCheckComplete: { backgroundColor: palette.green, color: 'white' },
  stepTitle: { fontSize: 17, fontWeight: '800', marginBottom: 8 },
  stepDetail: { color: palette.muted, fontSize: 14, lineHeight: '1.5' },
});

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
  const isCompact = useCompactLayout();
  const [completed, setCompleted] = useState<string[]>(['routes']);

  function toggleStep(id: string) {
    setCompleted(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
    ));
  }

  return (
    <ScrollScreen>
      <html.div style={[styles.screen, isCompact && styles.screenCompact]}>
        <html.div style={styles.container}>
          <html.div style={[styles.header, isCompact && styles.columnCompact]}>
            <html.div style={styles.brand}>
              <html.img
                src={brandMark}
                alt="OnRamp"
                width={46}
                height={46}
                style={styles.brandImage}
              />
              <html.div style={styles.brandName}>
                <html.span>OnRamp Starter</html.span>
              </html.div>
            </html.div>
            <html.div style={styles.status}>
              <html.span style={styles.statusDot}>●</html.span>
              <html.span>Ready to customize</html.span>
            </html.div>
          </html.div>

          <html.div style={[styles.featureRow, isCompact && styles.columnCompact]}>
            <html.div style={[styles.hero, isCompact && styles.heroCompact]}>
              <html.h1 style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                Ship one idea everywhere.
              </html.h1>
              <html.p style={styles.heroCopy}>
                OnRamp gives your app a Python backend, a universal React Native
                frontend, and file-based routing.
              </html.p>
              <html.div style={styles.actionRow}>
                <html.button
                  onClick={() => navigate('/profile/ada')}
                  style={styles.primaryButton}
                >
                  Open a dynamic route →
                </html.button>
              </html.div>
            </html.div>

            <html.div style={[styles.snapshot, isCompact && styles.fullWidthCompact]}>
              <html.img
                src={brandLockup}
                alt="OnRamp"
                width={170}
                height={148}
                style={styles.lockup}
              />
              <html.div style={styles.eyebrowMuted}>
                <html.span>Project snapshot</html.span>
              </html.div>
              <html.h2 style={styles.sectionTitle}>A useful starting line</html.h2>
              {[
                ['Frontend', 'Universal'],
                ['Navigation', 'File based'],
                ['Backend', 'Python'],
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

          <html.div style={styles.checklist}>
            <html.div style={styles.checklistHeader}>
              <html.div>
                <html.div style={styles.eyebrow}>
                  <html.span>YOUR LAUNCH CHECKLIST</html.span>
                </html.div>
                <html.h2 style={styles.checklistTitle}>Make the starter yours</html.h2>
              </html.div>
              <html.div style={styles.progress}>
                <html.span>
                  {completed.length} of {steps.length} complete · tap a step to update
                </html.span>
              </html.div>
            </html.div>
            <html.div style={[styles.stepRow, isCompact && styles.columnCompact]}>
              {steps.map(step => {
                const isComplete = completed.includes(step.id);
                return (
                  <html.button
                    key={step.id}
                    onClick={() => toggleStep(step.id)}
                    style={[
                      styles.stepCard,
                      isCompact && styles.fullWidthCompact,
                      isComplete && styles.stepCardComplete,
                    ]}
                  >
                    <html.div style={styles.stepTop}>
                      <html.span style={styles.stepNumber}>{step.number}</html.span>
                      <html.span
                        style={[styles.stepCheck, isComplete && styles.stepCheckComplete]}
                      >
                        {isComplete ? '✓' : '○'}
                      </html.span>
                    </html.div>
                    <html.div style={styles.stepTitle}>
                      <html.span>{step.title}</html.span>
                    </html.div>
                    <html.div style={styles.stepDetail}>
                      <html.span>{step.detail}</html.span>
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
