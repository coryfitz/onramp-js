import React from 'react';
import { html } from 'react-strict-dom';
import { useNavigation } from '../src/navigation/NavigationProvider';

export default function HomePage() {
  const { navigate } = useNavigation();

  function Greeting() {
    return (
      <html.div
        style={{
          color: '#333',
          marginBottom: 16,
          fontWeight: 'bold',
        } as any}
      >
        <html.h1 style={{ fontSize: 36 } as any}>Hello</html.h1>
        <html.h2 style={{ fontSize: 30 } as any}>I'm OnRamp</html.h2>
        <html.h2 style={{ fontSize: 30 } as any}>
          The Python App Framework
        </html.h2>
      </html.div>
    );
  }

  function Grid() {
    return (
      <html.div
        style={{
          backgroundColor: 'white',
          padding: 30,
          borderRadius: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          maxWidth: 500,
          alignSelf: 'center',
        } as any}
      >
        <html.h1
          style={{
            fontSize: 24,
            color: '#333',
            marginBottom: 16,
            fontWeight: 'bold',
            textAlign: 'center',
          } as any}
        >
          Welcome to OnRamp
        </html.h1>
        <html.h2
          style={{
            fontSize: 19,
            color: '#333',
            marginBottom: 16,
            fontWeight: 'bold',
            textAlign: 'center',
          } as any}
        >
          The Python App Framework
        </html.h2>
        <html.div
          style={{
            display: 'flex',
            gap: 10,
            justifyContent: 'center',
            flexDirection: 'column',
          } as any}
        >
          <html.button
            onClick={() => navigate('/profile/123')}
            style={{
              padding: '10px 20px',
              backgroundColor: '#007AFF',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            } as any}
          >
            Go to Profile
          </html.button>
          <html.button
            onClick={() => navigate('/about')}
            style={{
              padding: '10px 20px',
              backgroundColor: '#34C759',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            } as any}
          >
            About Page
          </html.button>
        </html.div>
      </html.div>
    );
  }

  return (
    <html.div
      style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: '#f5f5f5',
      } as any}
    >
      <Greeting />
      <Grid />
    </html.div>
  );
}
