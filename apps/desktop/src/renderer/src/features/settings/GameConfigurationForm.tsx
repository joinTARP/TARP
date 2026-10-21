import { companionRoleplayInstructions } from "@jointarp/core/shared/companion-roleplay";
import { defaultHostSystemPrompt } from "@jointarp/core/shared/host-system-prompt";
import { useRef, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useFlushSettings } from "./AutosaveScope";
import {
  ConfigurationFrame,
  GeneralConfiguration,
  HostPromptConfiguration,
  VoiceConfiguration,
  CompanionConfiguration,
  CompanionRoleplayConfiguration,
  CompactionConfiguration,
  ContextSubscriptionsConfiguration,
} from "./GameConfigurationFields";
import { useGameConfiguration, type GameConfigurationProps } from "./use-game-configuration";

type ConfigurationTab = "general" | "voice" | "companion" | "advanced";
const configurationTabs: { value: ConfigurationTab; label: string }[] = [
  { value: "general", label: "常规" },
  { value: "voice", label: "语音" },
  { value: "companion", label: "队友" },
  { value: "advanced", label: "进阶" },
];

export function GameDefaultsForm(props: GameConfigurationProps) {
  const configuration = useGameConfiguration(props, "configuration-voice-preview:defaults");
  const flush = useFlushSettings();
  const [tab, setTab] = useState<ConfigurationTab>("general");
  const changingTab = useRef(false);
  async function changeTab(next: ConfigurationTab) {
    if (next === tab || changingTab.current) return;
    changingTab.current = true;
    try {
      if (await flush()) {
        configuration.stopPreview();
        setTab(next);
      }
    } finally {
      changingTab.current = false;
    }
  }
  return (
    <ConfigurationFrame configuration={configuration} modelDescription="只影响之后创建的冒险。">
      <Tabs
        value={tab}
        onValueChange={(value) => void changeTab(value as ConfigurationTab)}
        className="gap-7"
      >
        <TabsList
          variant="line"
          aria-label="冒险默认设置分类"
          className="border-border/60 w-full justify-start border-b"
        >
          {configurationTabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="flex-none px-5">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="general">
          <GeneralConfiguration configuration={configuration} />
        </TabsContent>
        <TabsContent value="voice">
          <VoiceConfiguration
            configuration={configuration}
            title="语音"
            automaticDescription="新冒险自动朗读新消息，创建后可在游戏输入栏独立调整。"
          />
        </TabsContent>
        <TabsContent value="companion">
          <CompanionRoleplayConfiguration
            configuration={configuration}
            description="新冒险继承此指导，创建后可在冒险设置中单独修改。"
            resetValue={null}
          />
          <CompanionConfiguration
            configuration={configuration}
            description="创建冒险时保存模板；队友之后加入时使用该冒险的模板。"
          />
        </TabsContent>
        <TabsContent value="advanced">
          <HostPromptConfiguration
            configuration={configuration}
            description="调整新冒险的通用主持指令。"
            editorDescription="仅用于新建冒险；模组提示继续追加。"
            resetValue={null}
          />
          <CompactionConfiguration configuration={configuration} />
          <ContextSubscriptionsConfiguration configuration={configuration} />
        </TabsContent>
      </Tabs>
    </ConfigurationFrame>
  );
}

export type RoomConfigurationSection = "host" | "context" | "voice" | "party";

export function RoomConfigurationForm({
  roomId,
  section,
  ...props
}: GameConfigurationProps & { roomId: string; section: RoomConfigurationSection }) {
  const configuration = useGameConfiguration(props, `configuration-voice-preview:${roomId}`);
  return (
    <ConfigurationFrame configuration={configuration} modelDescription="只影响当前冒险。">
      {section === "host" ? (
        <HostPromptConfiguration
          configuration={configuration}
          description="只影响当前冒险，从下一次主持调用开始生效。"
          editorDescription="仅用于当前冒险；模组提示继续追加。"
          resetValue={defaultHostSystemPrompt}
        />
      ) : null}
      {section === "voice" ? (
        <VoiceConfiguration
          configuration={configuration}
          title="冒险语音配置"
          automaticDescription="仅影响当前冒险；游戏输入栏可独立调整。"
        />
      ) : null}
      {section === "context" ? (
        <ContextSubscriptionsConfiguration configuration={configuration} />
      ) : null}
      {section === "party" ? (
        <>
          <CompanionConfiguration
            configuration={configuration}
            description="修改后只用于之后加入的队友。已加入队友保留各自的设置。"
          />
          <CompanionRoleplayConfiguration
            configuration={configuration}
            description="影响本局所有 AI 队友，从下一次队友调用开始生效。"
            resetValue={companionRoleplayInstructions}
          />
        </>
      ) : null}
      <p role="status" className={configuration.busy ? "text-muted-foreground text-xs" : "sr-only"}>
        {configuration.busy ? "正在保存…" : ""}
      </p>
    </ConfigurationFrame>
  );
}
