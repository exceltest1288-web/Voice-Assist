
import React from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionsListProps {
  history: TranscriptionEntry[];
}

const TranscriptionsList: React.FC<TranscriptionsListProps> = ({ history }) => {
  return (
    <div className="flex flex-col space-y-4 p-4 max-h-[60vh] overflow-y-auto bg-white rounded-xl shadow-inner border border-slate-100">
      {history.length === 0 && (
        <p className="text-slate-400 text-center italic py-10">
          Start speaking to see the live translation...
        </p>
      )}
      {history.map((entry, idx) => (
        <div 
          key={entry.timestamp + idx} 
          className={`flex ${entry.speaker === 'user' ? 'justify-start' : 'justify-end'}`}
        >
          <div className={`max-w-[80%] rounded-2xl px-4 py-2 shadow-sm ${
            entry.speaker === 'user' 
              ? 'bg-blue-50 text-blue-900 rounded-tl-none border border-blue-100' 
              : 'bg-indigo-600 text-white rounded-tr-none'
          }`}>
            <p className={entry.text.match(/[\u0600-\u06FF]/) ? 'urdu-text text-xl text-right' : 'text-md font-medium'}>
              {entry.text}
            </p>
            <span className="text-[10px] opacity-70 block mt-1">
              {entry.speaker === 'user' ? 'Input' : 'Translation'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default TranscriptionsList;
