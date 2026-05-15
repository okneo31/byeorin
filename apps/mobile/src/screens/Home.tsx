import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createMnemonic } from '@nodong/wallet-sdk';
import { setMnemonic } from '../store';
import { colors, radius, spacing } from '../theme';

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

      <View style={styles.card}>
        <Text style={styles.label}>처음 사용하세요?</Text>
        <PrimaryButton title="지갑 생성" onPress={() => setMode('create')} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>이미 복구 문구가 있나요?</Text>
        <GhostButton title="복구" onPress={() => setMode('recover')} />
      </View>
    </ScrollView>
  );
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [mnemonic] = useState(() => createMnemonic(128, 'korean'));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    try {
      setMnemonic(mnemonic);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '지갑 생성에 실패했습니다.');
    }
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

      <View style={styles.card}>
        <Text style={styles.mnemonic} selectable>
          {mnemonic}
        </Text>
      </View>

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

      <PrimaryButton title="외웠습니다, 다음" disabled={!confirmed} onPress={onConfirm} />
      <GhostButton title="뒤로" onPress={onBack} />
    </ScrollView>
  );
}

function RecoverFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = () => {
    setError(null);
    try {
      setMnemonic(input);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '복구에 실패했습니다.');
    }
  };

  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h1}>지갑 복구</Text>
      <Text style={styles.lead}>
        12개 또는 24개의 복구 단어를 띄어쓰기로 입력하세요. 영어 또는 한국어 단어 모두 지원합니다.
      </Text>

      <View style={styles.card}>
        <Text style={styles.label}>복구 문구</Text>
        <TextInput
          style={styles.textarea}
          value={input}
          onChangeText={setInput}
          placeholder="예) word1 word2 word3 ..."
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={4}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <PrimaryButton title="복구하기" disabled={wordCount < 12} onPress={onSubmit} />
      <GhostButton title="뒤로" onPress={onBack} />
    </ScrollView>
  );
}

function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        styles.btnPrimary,
        pressed && !disabled && styles.btnPrimaryPressed,
        disabled && styles.btnDisabled,
      ]}
    >
      <Text style={styles.btnPrimaryText}>{title}</Text>
    </Pressable>
  );
}

function GhostButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.btnGhostPressed]}
    >
      <Text style={styles.btnGhostText}>{title}</Text>
    </Pressable>
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
  },
  lead: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  warn: {
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
  },
  mnemonic: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
  },
  textarea: {
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 96,
    textAlignVertical: 'top',
    fontSize: 15,
  },
  btn: {
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnPrimary: {
    backgroundColor: colors.primary,
  },
  btnPrimaryPressed: {
    backgroundColor: colors.primaryPressed,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnGhostPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  btnGhostText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.4,
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
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },
  checkText: {
    color: colors.text,
    fontSize: 14,
    flex: 1,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginVertical: spacing.sm,
  },
});
