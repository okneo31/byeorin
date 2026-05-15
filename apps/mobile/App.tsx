import { useEffect, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Home } from './src/screens/Home';
import { Account } from './src/screens/Account';
import { Send } from './src/screens/Send';
import { walletStore } from './src/store';
import { colors, spacing, theme } from './src/theme';

export type Screen = 'home' | 'account' | 'send';

function App(): React.JSX.Element {
  // H1: mobile(MemorySessionStore) 은 자동 복원이 허용되지 않는다.
  // 부팅 시점에는 항상 home 으로 시작한다.
  const [screen, setScreen] = useState<Screen>('home');

  useEffect(() => {
    // 자동 복원이 허용되는 환경에서만 동작. mobile 은 사실상 no-op.
    void walletStore.tryAutoRestore().then((restored) => {
      if (restored) setScreen('account');
    });
  }, []);

  const onLock = () => {
    void walletStore.lock();
    setScreen('home');
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.header}>
        <Text style={styles.brand}>노동자의 지갑</Text>
        {screen !== 'home' && (
          <Pressable
            accessibilityRole="button"
            onPress={onLock}
            style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
          >
            <Text style={styles.headerBtnText}>잠금</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.main}>
        {screen === 'home' && <Home onReady={() => setScreen('account')} />}
        {screen === 'account' && (
          <Account onSend={() => setScreen('send')} onLock={onLock} />
        )}
        {screen === 'send' && <Send onBack={() => setScreen('account')} />}
      </View>

      <Text style={styles.footer}>
        비수탁(non-custodial) 지갑 · 복구 문구는 앱 메모리에만 보관됩니다.{'\n'}
        앱을 종료하면 다시 잠금 상태로 돌아갑니다.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  brand: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.2,
    fontFamily: theme.font.korean,
  },
  headerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerBtnPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  headerBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: theme.font.korean,
  },
  main: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  footer: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: theme.font.korean,
  },
});

export default App;
