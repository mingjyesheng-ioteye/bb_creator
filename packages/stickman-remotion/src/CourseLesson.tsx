import React from 'react';
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame
} from 'remotion';
import type { CourseLessonAssessment, CourseLessonPresenter, CourseLessonSlide } from '@opencreator/protocol';
import {
  assertCourseLesson,
  buildCourseLessonTimeline,
  courseLessonAssessmentFrames,
  courseLessonSlidesFrames,
  type CourseLessonProps
} from './course-lesson.js';
import { localFontFaces, localFontFamily } from './fonts.js';
import { fileUrl } from './media.js';

export const CourseLessonLandscape: React.FC<CourseLessonProps> = (props) => (
  <CourseLessonVideo {...props} />
);

const CourseLessonVideo: React.FC<CourseLessonProps> = (props) => {
  const { lesson, fps, ratio } = props;
  assertCourseLesson(props);
  const timeline = buildCourseLessonTimeline(lesson);
  const slidesFrames = courseLessonSlidesFrames(lesson);
  const assessmentFrames = courseLessonAssessmentFrames(lesson.assessment, fps);
  const accent = lesson.presenter.accentColor || '#FFD166';

  return (
    <AbsoluteFill style={{ backgroundColor: '#0b1220', color: '#ffffff', fontFamily: localFontFamily }}>
      <style>{localFontFaces}</style>
      {timeline.map((entry) => (
        <Sequence
          key={entry.slide.id}
          from={entry.from}
          durationInFrames={entry.durationInFrames}
        >
          <LessonSlideView
            slide={entry.slide}
            presenter={lesson.presenter}
            brand={lesson.brand}
            courseTitle={lesson.courseTitle}
            moduleTitle={lesson.moduleTitle}
            ratio={ratio}
            fps={fps}
            accent={accent}
          />
        </Sequence>
      ))}
      {lesson.assessment && assessmentFrames > 0 ? (
        <Sequence from={slidesFrames} durationInFrames={assessmentFrames}>
          <AssessmentView assessment={lesson.assessment} accent={accent} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

const LessonSlideView: React.FC<{
  slide: CourseLessonSlide;
  presenter: CourseLessonPresenter;
  brand: string;
  courseTitle: string;
  moduleTitle: string;
  ratio: CourseLessonProps['ratio'];
  fps: number;
  accent: string;
}> = ({ slide, presenter, brand, courseTitle, moduleTitle, ratio, fps, accent }) => {
  const frame = useCurrentFrame();
  const portrait = ratio === '9:16';
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill>
      {slide.brollSrc ? (
        <OffthreadVideo
          src={fileUrl(slide.brollSrc)}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55 }}
        />
      ) : (
        <AbsoluteFill style={{ background: `linear-gradient(135deg, #0b1220 0%, #16233a 60%, ${accent}22 100%)` }} />
      )}

      {slide.audioSrc ? <Audio src={fileUrl(slide.audioSrc)} /> : null}

      <AbsoluteFill style={{ padding: portrait ? '120px 72px 220px' : '96px 120px 160px' }}>
        <div style={{ color: accent, fontSize: portrait ? 30 : 26, fontWeight: 700, letterSpacing: 1, opacity: 0.9 }}>
          {brand}
        </div>
        <div style={{ marginTop: 18, opacity: fade, maxWidth: portrait ? '100%' : 1180 }}>
          <h1 style={{ margin: 0, fontSize: slide.kind === 'title' ? (portrait ? 84 : 72) : (portrait ? 60 : 54), lineHeight: 1.1 }}>
            {slide.heading}
          </h1>
          {slide.sub ? (
            <p style={{ marginTop: 14, fontSize: portrait ? 34 : 30, color: 'rgba(255,255,255,0.72)' }}>{slide.sub}</p>
          ) : null}
          {slide.bullets.length > 0 ? (
            <ul style={{ marginTop: 28, paddingLeft: 0, listStyle: 'none' }}>
              {slide.bullets.map((bullet, index) => (
                <li
                  key={index}
                  style={{
                    marginTop: 16,
                    fontSize: portrait ? 34 : 32,
                    lineHeight: 1.35,
                    display: 'flex',
                    gap: 16,
                    alignItems: 'flex-start'
                  }}
                >
                  <span style={{ color: accent, lineHeight: 1.35 }}>•</span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </AbsoluteFill>

      {presenter.mode === 'video' && slide.avatarSrc ? (
        <div
          style={{
            position: 'absolute',
            right: portrait ? 40 : 72,
            bottom: portrait ? 260 : 72,
            width: portrait ? 300 : 360,
            height: portrait ? 300 : 240,
            borderRadius: 24,
            overflow: 'hidden',
            border: `3px solid ${accent}`,
            boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
            backgroundColor: '#0b1220'
          }}
        >
          <OffthreadVideo src={fileUrl(slide.avatarSrc)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ) : null}

      <SlideCaptions slide={slide} fps={fps} ratio={ratio} />

      <div
        style={{
          position: 'absolute',
          left: portrait ? 40 : 72,
          bottom: portrait ? 40 : 36,
          fontSize: portrait ? 24 : 22,
          color: 'rgba(255,255,255,0.5)'
        }}
      >
        {courseTitle} · {moduleTitle}
      </div>
    </AbsoluteFill>
  );
};

const SlideCaptions: React.FC<{
  slide: CourseLessonSlide;
  fps: number;
  ratio: CourseLessonProps['ratio'];
}> = ({ slide, fps, ratio }) => {
  const frame = useCurrentFrame();
  const words = slide.captions ?? [];
  if (words.length === 0) return null;
  const seconds = frame / fps;
  const portrait = ratio === '9:16';
  return (
    <div
      style={{
        position: 'absolute',
        left: portrait ? 48 : 120,
        right: portrait ? 48 : 120,
        bottom: portrait ? 140 : 120,
        textAlign: 'center',
        fontSize: portrait ? 40 : 36,
        fontWeight: 700,
        lineHeight: 1.25,
        textShadow: '0 2px 12px rgba(0,0,0,0.8)'
      }}
    >
      {words.map((word, index) => {
        const active = seconds >= word.start && seconds < word.end;
        return (
          <span
            key={index}
            style={{
              marginRight: 10,
              color: active ? '#FFD166' : '#ffffff',
              opacity: word.end <= seconds ? 0.82 : word.start > seconds ? 0.32 : 1
            }}
          >
            {word.word}
          </span>
        );
      })}
    </div>
  );
};

const AssessmentView: React.FC<{ assessment: CourseLessonAssessment; accent: string }> = ({ assessment, accent }) => (
  <AbsoluteFill style={{ backgroundColor: '#0b1220', padding: '96px 120px' }}>
    <div style={{ color: accent, fontSize: 26, fontWeight: 700, letterSpacing: 1 }}>Knowledge Check</div>
    <h1 style={{ marginTop: 18, fontSize: 52 }}>Review the key points</h1>
    <ol style={{ marginTop: 24, paddingLeft: 0, listStyle: 'none' }}>
      {assessment.questions.map((question, index) => (
        <li key={question.id} style={{ marginTop: 22, fontSize: 30, lineHeight: 1.35 }}>
          <span style={{ color: accent }}>{index + 1}.</span> {question.prompt}
          <div style={{ marginTop: 6, fontSize: 26, color: 'rgba(255,255,255,0.75)' }}>
            {question.options[question.answerIndex] ?? ''}
          </div>
        </li>
      ))}
    </ol>
  </AbsoluteFill>
);
