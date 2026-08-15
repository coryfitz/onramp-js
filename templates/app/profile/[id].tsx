import React from 'react';
import { html } from 'react-strict-dom';
import { useNavigation } from '../../src/navigation/NavigationProvider';

export default function ProfilePage({ id }) {
  const { navigate, goBack, canGoBack } = useNavigation();

  return (
    <html.div
      style={{
        padding: 20,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        flex: 1,
        backgroundColor: '#f5f5f5',
      } as any}
    >
      <html.div
        style={{
          backgroundColor: 'white',
          padding: 30,
          borderRadius: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          maxWidth: 600,
        } as any}
      >
        <html.h1 style={{ color: '#333', marginBottom: 16 } as any}>
          Profile Page
        </html.h1>
        <html.p style={{ color: '#666', marginBottom: 20 } as any}>
          Profile ID: {id || 'No ID provided'}
        </html.p>
        <html.div style={{ display: 'flex', gap: 10 } as any}>
          {canGoBack() && (
            <html.button
              onClick={goBack}
              style={{
                padding: '10px 20px',
                backgroundColor: '#666',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              } as any}
            >
              Go Back
            </html.button>
          )}
          <html.button
            onClick={() => navigate('/')}
            style={{
              padding: '10px 20px',
              backgroundColor: '#007AFF',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            } as any}
          >
            Home
          </html.button>
        </html.div>
      </html.div>
    </html.div>
  );
}
