import React from 'react';
import { Composition } from 'remotion';
import { courseLessonSchemaVersion } from '@opencreator/protocol';
import { StickmanLandscape, StickmanPortrait } from './StickmanLandscape.js';
import type { StickmanTimelineProps } from './timeline.js';
import { CourseLessonLandscape } from './CourseLesson.js';
import { courseLessonTotalFrames, type CourseLessonProps } from './course-lesson.js';

const defaultProps: StickmanTimelineProps = {
  ratio: '16:9',
  fps: 30,
  width: 1280,
  height: 720,
  totalFrames: 30,
  shots: [],
  captions: []
};

const portraitDefaultProps: StickmanTimelineProps = {
  ...defaultProps,
  ratio: '9:16',
  width: 720,
  height: 1280
};

const courseLessonDefaultProps: CourseLessonProps = {
  ratio: '16:9',
  fps: 30,
  width: 1920,
  height: 1080,
  lesson: {
    schemaVersion: courseLessonSchemaVersion,
    id: 'preview',
    brand: 'OpenCreator',
    courseTitle: 'Course',
    moduleTitle: 'Lesson',
    moduleIndex: 1,
    moduleTotal: 1,
    presenter: {
      mode: 'placeholder',
      layout: 'pip-br',
      name: 'Instructor',
      role: 'Training Instructor',
      accentColor: '#FFD166'
    },
    slides: [
      {
        id: 'preview:title',
        kind: 'title',
        heading: 'Lesson',
        bullets: [],
        narration: 'Lesson',
        durationInFrames: 30
      }
    ]
  }
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="StickmanLandscape"
      component={StickmanLandscape}
      width={1280}
      height={720}
      fps={30}
      durationInFrames={30}
      defaultProps={defaultProps}
      calculateMetadata={({ props }: { props: StickmanTimelineProps }) => ({
        durationInFrames: props.totalFrames,
        fps: props.fps,
        width: props.width,
        height: props.height
      })}
    />
    <Composition
      id="StickmanPortrait"
      component={StickmanPortrait}
      width={720}
      height={1280}
      fps={30}
      durationInFrames={30}
      defaultProps={portraitDefaultProps}
      calculateMetadata={({ props }: { props: StickmanTimelineProps }) => ({
        durationInFrames: props.totalFrames,
        fps: props.fps,
        width: props.width,
        height: props.height
      })}
    />
    <Composition
      id="CourseLessonLandscape"
      component={CourseLessonLandscape}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={30}
      defaultProps={courseLessonDefaultProps}
      calculateMetadata={({ props }: { props: CourseLessonProps }) => ({
        durationInFrames: courseLessonTotalFrames(props.lesson, props.fps),
        fps: props.fps,
        width: props.width,
        height: props.height
      })}
    />
  </>
);
