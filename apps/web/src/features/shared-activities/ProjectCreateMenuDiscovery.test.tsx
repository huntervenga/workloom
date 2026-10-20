import {createRef} from 'react';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,it,vi} from 'vitest';
import {ProjectCreateMenu} from '../projects/ProjectCreateMenu';

it('makes the shared call entry discoverable from Add task options without creating anything automatically',async()=>{
 const onAddTask=vi.fn(),onAddSection=vi.fn(),onAddSharedActivity=vi.fn(),user=userEvent.setup();
 render(<ProjectCreateMenu onAddTask={onAddTask} onAddSection={onAddSection} onAddSharedActivity={onAddSharedActivity} returnFocus={createRef<HTMLButtonElement>()}/>);
 const options=screen.getByRole('button',{name:'More add options'});expect(options).toHaveAttribute('title','Add a shared call or section');expect(onAddSharedActivity).not.toHaveBeenCalled();
 await user.click(options);const call=screen.getByRole('menuitem',{name:'Shared call'});expect(call).toBeVisible();expect(screen.getByRole('menuitem',{name:'Add section'})).toBeVisible();
 await user.click(call);expect(onAddSharedActivity).toHaveBeenCalledTimes(1);expect(onAddTask).not.toHaveBeenCalled();expect(onAddSection).not.toHaveBeenCalled();
});

it('keeps the ordinary task action and hides the shared call entry when no shared action is available',async()=>{
 const onAddTask=vi.fn(),onAddSection=vi.fn(),user=userEvent.setup();
 render(<ProjectCreateMenu onAddTask={onAddTask} onAddSection={onAddSection} returnFocus={createRef<HTMLButtonElement>()}/>);
 await user.click(screen.getByRole('button',{name:'Add task'}));expect(onAddTask).toHaveBeenCalledTimes(1);
 await user.click(screen.getByRole('button',{name:'More add options'}));expect(screen.queryByRole('menuitem',{name:'Shared call'})).not.toBeInTheDocument();expect(screen.getByRole('menuitem',{name:'Add section'})).toBeVisible();
});
