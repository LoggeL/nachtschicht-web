import { useEffect } from 'react';
import { useGameStore } from '../state/store';
import { loadAssetManifest } from './assets';
import { StoryModal } from './components/StoryModal';
import { TitleScreen } from './screens/TitleScreen';
import { SafehouseScreen } from './screens/SafehouseScreen';
import { ReissbrettScreen } from './screens/ReissbrettScreen';
import { WorldOverlayHUD } from './screens/WorldOverlayHUD';
import { DebriefScreen } from './screens/DebriefScreen';

export default function App() {
  const phase = useGameStore((s) => s.phase);

  useEffect(() => {
    void loadAssetManifest();
  }, []);

  const renderPhase = () => {
    switch (phase) {
      case 'title':
        return <TitleScreen />;
      case 'safehouse':
        return <SafehouseScreen />;
      case 'planning':
        return <ReissbrettScreen />;
      case 'scouting':
      case 'executing':
      case 'escape':
        return <WorldOverlayHUD />;
      case 'debrief':
        return <DebriefScreen />;
      default:
        return <TitleScreen />;
    }
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#060b16] text-slate-100">
      {renderPhase()}
      <StoryModal />
    </div>
  );
}
