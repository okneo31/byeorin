import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createMnemonic } from '@byeorin/wallet-sdk';
import { ShellError } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { Button, Card, Input } from '../ui';

type Mode = 'choose' | 'create' | 'recover';

interface Props {
  onReady: () => void;
}

/** shell-core 도메인 에러를 사용자 언어로 매핑한다. */
function localizeError(t: (k: string) => string, e: unknown, fallback: string): string {
  if (e instanceof ShellError) return t(`errors.${e.code}`);
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

export function Home({ onReady }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('choose');

  if (mode === 'create') {
    return <CreateFlow onDone={onReady} onBack={() => setMode('choose')} />;
  }
  if (mode === 'recover') {
    return <RecoverFlow onDone={onReady} onBack={() => setMode('choose')} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('brand.tagline')}</Text>
      <Text style={styles.lead}>{t('home.lead')}</Text>

      <Card style={styles.section}>
        <Text style={styles.label}>{t('home.new_user_question')}</Text>
        <Button variant="primary" fullWidth onPress={() => setMode('create')}>
          {t('home.create_button')}
        </Button>
      </Card>

      <Card style={styles.section}>
        <Text style={styles.label}>{t('home.recover_question')}</Text>
        <Button variant="secondary" fullWidth onPress={() => setMode('recover')}>
          {t('recover.submit')}
        </Button>
      </Card>
    </ScrollView>
  );
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useT();
  const [mnemonic] = useState(() => createMnemonic(128, 'korean'));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onConfirm = () => {
    setBusy(true);
    void (async () => {
      try {
        await walletStore.unlock(mnemonic);
        onDone();
      } catch (e) {
        setError(localizeError(t, e, t('create.failed')));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('create.title')}</Text>
      <Text style={styles.lead}>{t('create.lead')}</Text>

      <View style={styles.warn}>
        <Text style={styles.warnText}>{t('create.warn')}</Text>
      </View>

      <Card style={styles.section}>
        <Text style={styles.mnemonic} selectable>
          {mnemonic}
        </Text>
      </Card>

      <Pressable
        onPress={() => setConfirmed(!confirmed)}
        style={styles.checkRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: confirmed }}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxOn]}>
          {confirmed && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkText}>{t('create.checkbox_safe')}</Text>
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}

      <Button
        variant="primary"
        fullWidth
        disabled={!confirmed}
        loading={busy}
        onPress={onConfirm}
      >
        {t('create.confirm_done')}
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        {t('common.back')}
      </Button>
    </ScrollView>
  );
}

function RecoverFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = () => {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        await walletStore.unlock(input);
        onDone();
      } catch (e) {
        setError(localizeError(t, e, t('recover.failed')));
      } finally {
        setBusy(false);
      }
    })();
  };

  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>{t('recover.title')}</Text>
      <Text style={styles.lead}>{t('recover.lead')}</Text>

      <Card style={styles.section}>
        <Input
          label={t('recover.label')}
          value={input}
          onChangeText={setInput}
          placeholder={t('recover.placeholder')}
          multiline
          numberOfLines={4}
          autoCapitalize="none"
          autoCorrect={false}
          error={error ?? undefined}
        />
      </Card>

      <Button
        variant="primary"
        fullWidth
        disabled={wordCount < 12}
        loading={busy}
        onPress={onSubmit}
      >
        {t('recover.submit')}
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        {t('common.back')}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xl,
  },
  h1: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
    marginBottom: spacing.sm,
    fontFamily: theme.font.korean,
  },
  lead: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.lg,
    fontFamily: theme.font.korean,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: theme.font.korean,
  },
  // Each Card needs its own bottom margin in the screen layout. Card itself
  // doesn't ship spacing — that's a layout decision, not a primitive concern.
  section: {
    marginBottom: spacing.md,
  },
  warn: {
    // TODO(design-system): no dark-tinted warn surface in DS — local value.
    backgroundColor: '#3a2a00',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  warnText: {
    color: colors.warn,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: theme.font.korean,
  },
  mnemonic: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    // The Korean BIP-39 wordlist is Hangul, so apply the Korean stack here too.
    fontFamily: theme.font.korean,
  },
  btnSpacer: {
    height: spacing.sm,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.border,
    marginRight: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: {
    // Pure white check on filled brand-red box. Not DS's warm `paper`.
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },
  checkText: {
    color: colors.text,
    fontSize: 14,
    flex: 1,
    fontFamily: theme.font.korean,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginVertical: spacing.sm,
    fontFamily: theme.font.korean,
  },
});
