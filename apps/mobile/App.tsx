import { useEffect, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  I18nProvider,
  createMemoryLocaleStorage,
  useLocale,
  useT,
} from '@byeorin/i18n/react';
import { Home } from './src/screens/Home';
import { Account } from './src/screens/Account';
import { Send } from './src/screens/Send';
import { DApp } from './src/screens/DApp';
import { walletStore } from './src/store';
import { colors, spacing, theme } from './src/theme';

export type Screen = 'home' | 'account' | 'send' | 'dapp' | 'settings';

/**
 * 모바일 셸. v0.4 에서는 영속 로케일 저장소를 메모리로만 둔다 — AsyncStorage
 * 도입 시 createMemoryLocaleStorage 를 createAsyncStorageLocaleStorage 로 바꿀
 * 예정 (TODO).
 */
function AppRoot(): React.JSX.Element {
  return (
    <I18nProvider persistence={createMemoryLocaleStorage()}>
      <App />
    </I18nProvider>
  );
}

function App(): React.JSX.Element {
  const t = useT();
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

  // 비수탁 안내 — 카탈로그 값에 개행이 들어 있어 join 으로 합친다 (React Native Text 내부는 \n 으로 OK).
  const footer = t('footer.non_custodial.mobile');

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.header}>
        <Text style={styles.brand}>{t('brand.name')}</Text>
        <View style={styles.headerActions}>
          <LocaleToggle />
          {screen !== 'home' && (
            <>
              {screen === 'account' && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setScreen('dapp')}
                  style={({ pressed }) => [
                    styles.headerBtn,
                    pressed && styles.headerBtnPressed,
                  ]}
                >
                  <Text style={styles.headerBtnText}>{t('common.dApp')}</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={onLock}
                style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
              >
                <Text style={styles.headerBtnText}>{t('common.lock')}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>

      <View style={styles.main}>
        {screen === 'home' && <Home onReady={() => setScreen('account')} />}
        {screen === 'account' && (
          <Account onSend={() => setScreen('send')} onLock={onLock} />
        )}
        {screen === 'send' && <Send onBack={() => setScreen('account')} />}
        {screen === 'dapp' && <DApp onBack={() => setScreen('account')} />}
      </View>

      <Text style={styles.footer}>{footer}</Text>
    </SafeAreaView>
  );
}

/**
 * 헤더의 ko/en 토글 — react-native 에는 <select> 가 없어 단순 Pressable 두 개로 구현.
 *
 * 향후 Settings 화면이 추가되면 그쪽으로 옮길 후보. 지금은 헤더에 두어 항상 접근 가능.
 */
function LocaleToggle(): React.JSX.Element {
  const { locale, setLocale } = useLocale();
  const next = locale === 'ko' ? 'en' : 'ko';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={locale === 'ko' ? 'English' : '한국어'}
      onPress={() => setLocale(next)}
      style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
    >
      <Text style={styles.headerBtnText}>{locale === 'ko' ? 'EN' : 'KO'}</Text>
    </Pressable>
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
  headerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
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

export default AppRoot;
