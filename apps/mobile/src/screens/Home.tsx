import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createMnemonic } from '@nodong/wallet-sdk';
import { walletStore } from '../store';
import { colors, radius, spacing, theme } from '../theme';
import { Button, Card, Input } from '../ui';

type Mode = 'choose' | 'create' | 'recover';

interface Props {
  onReady: () => void;
}

export function Home({ onReady }: Props) {
  const [mode, setMode] = useState<Mode>('choose');

  if (mode === 'create') {
    return <CreateFlow onDone={onReady} onBack={() => setMode('choose')} />;
  }
  if (mode === 'recover') {
    return <RecoverFlow onDone={onReady} onBack={() => setMode('choose')} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>노동자에게 자기 결정권을.</Text>
      <Text style={styles.lead}>
        수수료 투명, 다크 패턴 없음, 데이터는 당신의 기기에. TTL 체인을 포함한 EVM 호환 자산을
        쉽고 안전하게.
      </Text>

      <Card style={styles.section}>
        <Text style={styles.label}>처음 사용하세요?</Text>
        <Button variant="primary" fullWidth onPress={() => setMode('create')}>
          지갑 생성
        </Button>
      </Card>

      <Card style={styles.section}>
        <Text style={styles.label}>이미 복구 문구가 있나요?</Text>
        <Button variant="secondary" fullWidth onPress={() => setMode('recover')}>
          복구하기
        </Button>
      </Card>
    </ScrollView>
  );
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
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
        setError(e instanceof Error ? e.message : '지갑 생성에 실패했습니다.');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>복구 문구를 기억하세요</Text>
      <Text style={styles.lead}>
        아래 12개 단어는 당신의 지갑 그 자체입니다. 종이에 적거나 안전한 곳에 보관하세요.
        절대 다른 사람과 공유하지 마세요.
      </Text>

      <View style={styles.warn}>
        <Text style={styles.warnText}>
          이 문구를 잃어버리면 지갑을 복구할 수 없습니다. 화면 캡처는 권하지 않습니다.
        </Text>
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
        <Text style={styles.checkText}>위 12개 단어를 안전하게 보관했습니다.</Text>
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}

      <Button
        variant="primary"
        fullWidth
        disabled={!confirmed}
        loading={busy}
        onPress={onConfirm}
      >
        외웠습니다, 다음
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        뒤로
      </Button>
    </ScrollView>
  );
}

function RecoverFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
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
        setError(e instanceof Error ? e.message : '복구에 실패했습니다.');
      } finally {
        setBusy(false);
      }
    })();
  };

  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>지갑 복구</Text>
      <Text style={styles.lead}>
        12개 또는 24개의 복구 단어를 띄어쓰기로 입력하세요. 영어 또는 한국어 단어 모두 지원합니다.
      </Text>

      <Card style={styles.section}>
        <Input
          label="복구 문구"
          value={input}
          onChangeText={setInput}
          placeholder="예) word1 word2 word3 ..."
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
        복구하기
      </Button>
      <View style={styles.btnSpacer} />
      <Button variant="ghost" fullWidth onPress={onBack}>
        뒤로
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
